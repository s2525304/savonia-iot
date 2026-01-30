import type { InvocationContext } from "@azure/functions";
import { BlobServiceClient, BlockBlobTier } from "@azure/storage-blob";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";

import { createLogger } from "../shared/log";
import { loadConfig } from "../shared/config";
import { parseTelemetryBatch } from "../shared/iothub/parseTelemetry";
import type { TelemetryMessage } from "../shared/iothub/telemetry";

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

function mapTier(tier: "Hot" | "Cool" | "Cold" | "Archive"): BlockBlobTier {
	switch (tier) {
		case "Hot": return BlockBlobTier.Hot;
		case "Cool": return BlockBlobTier.Cool;
		case "Cold": return BlockBlobTier.Cold;
		case "Archive": return BlockBlobTier.Archive;
	}
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
let containerClient: ReturnType<BlobServiceClient["getContainerClient"]> | null = null;
let containerEnsured = false;

function getBlobServiceClient(): BlobServiceClient {
	if (!blobClient) {
		const cfg = loadConfig();
		blobClient = BlobServiceClient.fromConnectionString(
			cfg.blobWriter.connectionString
		);
	}
	return blobClient;
}

async function getContainerClient(): Promise<ReturnType<BlobServiceClient["getContainerClient"]>> {
	const cfg = loadConfig().blobWriter;

	if (!containerClient) {
		const svc = getBlobServiceClient();
		containerClient = svc.getContainerClient(cfg.container);
	}

	// Avoid doing an existence check on every invocation. This reduces storage read ops.
	if (!containerEnsured) {
		await containerClient.createIfNotExists();
		containerEnsured = true;
	}

	return containerClient;
}

export async function runBlobWriter(events: unknown, context: InvocationContext): Promise<void> {
	const log = createLogger(context);

	const cfg = loadConfig().blobWriter;

	const containerName = cfg.container;
	const gzipEnabled = cfg.gzip;
	const prefix = cfg.prefix;
	const tier = mapTier(cfg.tier);

	if (events == null || (Array.isArray(events) && events.length === 0)) {
		log.debug("blob-writer: no events");
		return;
	}

	const container = await getContainerClient();

	const parsed = parseTelemetryBatch(events, context);
	const messages: TelemetryMessage[] = parsed.ok;
	const parsedOk = parsed.ok.length;
	const parsedBad = parsed.bad.length;

	if (messages.length === 0) {
		log.info("blob-writer: nothing to write", { parsedOk, parsedBad });
		return;
	}

	// Partition by hour based on event timestamp (UTC) to keep files reasonably sized.
	// Also split by deviceId to avoid hot blobs when many devices send concurrently.
	const byPartition = new Map<string, TelemetryMessage[]>();
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
		received: Array.isArray(events) ? events.length : 1,
		parsedOk,
		parsedBad,
		uploaded,
		failed,
		container: containerName,
		tier: cfg.tier
	});
}