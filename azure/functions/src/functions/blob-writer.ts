import type { InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import pMap from "p-map";

import { createLogger } from "../shared/log";
import { loadConfig } from "../shared/config";
import { parseQueueMessages } from "../shared/queue/parseQueueMessage";
import type { TelemetryMessage } from "../shared/eventhub/telemetry";

// We store IoT Hub telemetry events into a cold-storage blob container as JSONL append blobs.
//
// Expected payload (from the Azure Storage Queue message):
// Array of TelemetryMessage objects
//
// Env vars (Function App settings):
// - COLD_STORAGE_CONNECTION_STRING (required)
// - COLD_STORAGE_CONTAINER (optional, default: telemetry-archive)
// - COLD_STORAGE_GZIP (optional: true|false, default: true) - ignored in append-blob mode
// - COLD_STORAGE_PREFIX (optional, default: telemetry)
//
// Blobs are written as .jsonl append blobs, grouped by deviceId + sensorId + hour (UTC).
// Gzip compression is ignored in append-blob mode.

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

export async function runBlobWriter(queueItem: unknown, context: InvocationContext): Promise<void> {
	const log = createLogger(context);
	const cfg = loadConfig().blobWriter;

	const containerName = cfg.container;
	const prefix = cfg.prefix;
	const gzipEnabled = cfg.gzip;

	if (gzipEnabled) {
		log.debug("blob-writer: gzip is configured but ignored (append-blob mode)");
	}

	const messages = parseQueueMessages<TelemetryMessage>(queueItem);
	if (messages.length === 0) {
		log.debug("blob-writer: no messages");
		return;
	}

	const container = await getContainerClient();

	// Partition key: yyyy/mm/dd/hh/deviceId/sensorId (UTC hour)
	const byPartition = new Map<string, TelemetryMessage[]>();
	for (const m of messages) {
		const { yyyy, mm, dd, hh } = datePathParts(m.ts);
		const device = sanitizePathPart(m.deviceId);
		const sensor = sanitizePathPart(m.sensorId);
		const key = `${yyyy}/${mm}/${dd}/${hh}/${device}/${sensor}`;
		const arr = byPartition.get(key) ?? [];
		arr.push(m);
		byPartition.set(key, arr);
	}

	let appended = 0;
	let failed = 0;

	const CONCURRENCY = Number.parseInt(process.env.BLOB_WRITE_CONCURRENCY ?? "8", 10) || 8;

	await pMap(
		Array.from(byPartition.entries()),
		async ([key, batch]) => {
			// NDJSON (uncompressed to allow append)
			const ndjson = `${batch.map(b => JSON.stringify(b)).join("\n")}\n`;
			const data = Buffer.from(ndjson, "utf8");

			const blobName = `${prefix}/${key}.jsonl`;

			try {
				const blob = container.getAppendBlobClient(blobName);

				// Create once (idempotent). Set HTTP headers to create operation.
				await blob.createIfNotExists({
					blobHTTPHeaders: {
						blobContentType: "application/x-ndjson; charset=utf-8"
					}
				});

				await blob.appendBlock(data, data.length);
				appended += batch.length;
			} catch (err) {
				failed += batch.length;
				log.error("blob-writer: append failed", { blobName, err: String(err) });
			}
		},
		{ concurrency: CONCURRENCY }
	);

	log.info("blob-writer: done", {
		received: messages.length,
		partitions: byPartition.size,
		appended,
		failed,
		container: containerName
	});
}