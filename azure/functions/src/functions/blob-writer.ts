import type { InvocationContext } from "@azure/functions";
import { BlobServiceClient, BlockBlobTier } from "@azure/storage-blob";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";

import { createLogger } from "../shared/log";
import { loadConfig } from "../shared/config";

// We store IoT Hub telemetry events into a cold-storage blob container as JSONL (optionally gzipped).
//
// Expected payload (from MQTT -> IoT Hub -> Event Hub):
// {
//   schemaVersion: 1,
//   deviceId: string,
//   sensorId: string,
//   ts: string,
//   seq: number,
//   type: string,
//   valueType: "number"|"boolean"|"string"|"enum",
//   value: number|boolean|string,
//   unit?: string,
//   location?: string
// }
//
// Env vars (Function App settings):
// - COLD_STORAGE_CONNECTION_STRING (required)
// - COLD_STORAGE_CONTAINER (optional, default: telemetry-archive)
// - COLD_STORAGE_TIER (optional: Hot|Cool|Cold|Archive, default: Cool)
// - COLD_STORAGE_GZIP (optional: true|false, default: true)
// - COLD_STORAGE_PREFIX (optional, default: telemetry)

export interface TelemetryMessageV1 {
	schemaVersion: 1;
	deviceId: string;
	sensorId: string;
	ts: string;
	seq: number;
	type: string;
	valueType: "number" | "boolean" | "string" | "enum";
	value: number | boolean | string;
	unit?: string;
	location?: string;
}

function mapTier(tier: "Hot" | "Cool" | "Cold" | "Archive"): BlockBlobTier {
	switch (tier) {
		case "Hot": return BlockBlobTier.Hot;
		case "Cool": return BlockBlobTier.Cool;
		case "Cold": return BlockBlobTier.Cold;
		case "Archive": return BlockBlobTier.Archive;
	}
}

function safeJsonParse(input: string): unknown {
	try {
		return JSON.parse(input);
	} catch {
		return undefined;
	}
}

function extractEventBody(event: unknown): string | undefined {
	// Azure Event Hub trigger can deliver:
	// - string
	// - Buffer
	// - object with a `body` field
	if (typeof event === "string") return event;
	if (Buffer.isBuffer(event)) return event.toString("utf8");

	if (event && typeof event === "object") {
		const anyEvent = event as { body?: unknown };
		const body = anyEvent.body;
		if (typeof body === "string") return body;
		if (Buffer.isBuffer(body)) return body.toString("utf8");
		// Sometimes the body is already parsed JSON
		if (body && typeof body === "object") return JSON.stringify(body);
	}

	return undefined;
}

function datePathParts(tsIso: string): { yyyy: string; mm: string; dd: string; hh: string } {
	const d = new Date(tsIso);
	const yyyy = String(d.getUTCFullYear());
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	return { yyyy, mm, dd, hh };
}

function sanitizePathPart(v: string): string {
	// Keep it blob-path safe.
	return v
		.trim()
		.replace(/\s+/g, "_")
		.replace(/[^a-zA-Z0-9._\-]/g, "-")
		.slice(0, 128);
}

let blobClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
	if (!blobClient) {
		const cfg = loadConfig();
		blobClient = BlobServiceClient.fromConnectionString(
			cfg.blobWriter.connectionString
		);
	}
	return blobClient;
}

export async function runBlobWriter(events: unknown[], context: InvocationContext): Promise<void> {
	const log = createLogger(context);

	const cfg = loadConfig().blobWriter;

	const containerName = cfg.container;
	const gzipEnabled = cfg.gzip;
	const prefix = cfg.prefix;
	const tier = mapTier(cfg.tier);

	if (!Array.isArray(events) || events.length === 0) {
		log.debug("blob-writer: no events");
		return;
	}

	const svc = getBlobServiceClient();
	const container = svc.getContainerClient(containerName);
	await container.createIfNotExists();

	let parsedOk = 0;
	let parsedBad = 0;
	const messages: TelemetryMessageV1[] = [];

	for (const ev of events) {
		const bodyStr = extractEventBody(ev);
		if (!bodyStr) {
			parsedBad++;
			continue;
		}

		const obj = safeJsonParse(bodyStr);
		if (!obj || typeof obj !== "object") {
			parsedBad++;
			continue;
		}

		// Minimal validation (avoid heavy deps in a cold-path ingestion function).
		const m = obj as Partial<TelemetryMessageV1>;
		if (
			m.schemaVersion !== 1 ||
			typeof m.deviceId !== "string" ||
			typeof m.sensorId !== "string" ||
			typeof m.ts !== "string" ||
			typeof m.seq !== "number" ||
			typeof m.type !== "string" ||
			(m.valueType !== "number" && m.valueType !== "boolean" && m.valueType !== "string" && m.valueType !== "enum")
		) {
			parsedBad++;
			continue;
		}

		messages.push(m as TelemetryMessageV1);
		parsedOk++;
	}

	if (messages.length === 0) {
		log.info("blob-writer: nothing to write", { parsedBad });
		return;
	}

	// Partition by hour based on event timestamp (UTC) to keep files reasonably sized.
	// Also split by deviceId to avoid hot blobs when many devices send concurrently.
	const byPartition = new Map<string, TelemetryMessageV1[]>();
	for (const m of messages) {
		const { yyyy, mm, dd, hh } = datePathParts(m.ts);
		const device = sanitizePathPart(m.deviceId);
		const key = `${yyyy}/${mm}/${dd}/${hh}/${device}`;
		const arr = byPartition.get(key) ?? [];
		arr.push(m);
		byPartition.set(key, arr);
	}

	let uploaded = 0;
	let failed = 0;

	for (const [key, batch] of byPartition.entries()) {
		// JSON Lines
		const jsonl = `${batch.map(b => JSON.stringify(b)).join("\n")}\n`;
		const raw = Buffer.from(jsonl, "utf8");
		const data = gzipEnabled ? gzipSync(raw) : raw;

		const ext = gzipEnabled ? "jsonl.gz" : "jsonl";
		const file = `${new Date().toISOString()}_${randomUUID()}.${ext}`;
		const blobName = `${prefix}/${key}/${file}`;

		try {
			const blob = container.getBlockBlobClient(blobName);
			await blob.uploadData(data, {
				blobHTTPHeaders: {
					blobContentType: "application/x-ndjson",
					...(gzipEnabled ? { blobContentEncoding: "gzip" } : {})
				},
				tier
			});
			uploaded += batch.length;
		} catch (err) {
			failed += batch.length;
			log.error("blob-writer: upload failed", { blobName, err: String(err) });
		}
	}

	log.info("blob-writer: done", {
		received: events.length,
		parsedOk,
		parsedBad,
		uploaded,
		failed,
		container: containerName,
		tier: cfg.tier
	});
}