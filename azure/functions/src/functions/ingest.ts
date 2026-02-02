

import type { InvocationContext } from "@azure/functions";
import { QueueClient } from "@azure/storage-queue";
import pMap from "p-map";

import { parseTelemetryBatch } from "../shared/eventhub/parseTelemetry";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

const STORAGE_CONN = requireEnv("AzureWebJobsStorage");

// Queue names are configured in Function App settings and created by infra (01-infra.sh)
const QUEUE_DB_WRITE = requireEnv("QUEUE_DB_WRITE");
const QUEUE_ALERTS = requireEnv("QUEUE_ALERTS");
const QUEUE_BLOB_BATCH = requireEnv("QUEUE_BLOB_BATCH");

// Create clients once per warm instance
const qDb = new QueueClient(STORAGE_CONN, QUEUE_DB_WRITE);
const qAlerts = new QueueClient(STORAGE_CONN, QUEUE_ALERTS);
const qBlob = new QueueClient(STORAGE_CONN, QUEUE_BLOB_BATCH);

async function sendJson(queue: QueueClient, payload: unknown): Promise<void> {
	// Azure Storage Queue messages are strings; the SDK will encode appropriately.
	await queue.sendMessage(JSON.stringify(payload));
}

async function enqueueToAllQueues(message: unknown): Promise<void> {
	// Fan-out: The same validated message goes to all queues.
	await Promise.all([
		sendJson(qDb, message),
		sendJson(qAlerts, message),
		sendJson(qBlob, message)
	]);
}


/**
 * Event Hub trigger handler: validate telemetry batch and fan-out valid messages to queues.
 */
export async function ingest(events: unknown, context: InvocationContext): Promise<void> {
	const { ok, bad } = parseTelemetryBatch(events, context);

	if (bad.length > 0) {
		context.warn?.("ingest: dropped invalid telemetry events", {
			ok: ok.length,
			bad: bad.length,
			sample: bad.slice(0, 3).map(b => ({
				issues: b.issues,
				bodyPreview: b.bodyPreview
			}))
		});
	}

	if (ok.length === 0) return;

	// Tunable: limits outbound queue requests.
	// Each item produces 3 queue sends; too high concurrency can trigger throttling.
	const CONCURRENCY = Number.parseInt(process.env.QUEUE_ENQUEUE_CONCURRENCY ?? "32", 10) || 32;

	try {
		await pMap(ok, async (m) => {
			await enqueueToAllQueues(m);
		}, { concurrency: CONCURRENCY });
	} catch (err) {
		context.error("ingest: failed to enqueue some telemetry messages", {
			total: ok.length,
			queues: {
				db: QUEUE_DB_WRITE,
				alerts: QUEUE_ALERTS,
				blob: QUEUE_BLOB_BATCH
			}
		});
		// Fail the invocation, so Event Hub retries. Downstream processors must be idempotent.
		throw err instanceof Error ? err : new Error(String(err));
	}

	context.log("ingest: enqueued telemetry batch", {
		count: ok.length,
		queues: {
			db: QUEUE_DB_WRITE,
			alerts: QUEUE_ALERTS,
			blob: QUEUE_BLOB_BATCH
		}
	});
}