import { parseQueueMessages } from "../shared/queue/parseQueueMessage";
import type { InvocationContext } from "@azure/functions";

import { query } from "../shared/db";
import { createLogger } from "../shared/log";
import { loadConfig } from "../shared/config";
import { Sql } from "../shared/sql";
import type { TelemetryMessage } from "../shared/eventhub/telemetry";


// Map telemetry message to DB columns
function mapTelemetryToDb(msg: TelemetryMessage): {
	device_id: string;
	sensor_id: string;
	ts: string;
	seq: number;
	type: string;
	value_type: string;
	value_number: number | null;
	value_boolean: boolean | null;
	value_text: string | null;
	unit: string | null;
	location: string | null;
} {
	let valueNumber: number | null = null;
	let valueBoolean: boolean | null = null;
	let valueText: string | null = null;

	switch (msg.valueType) {
		case "number":
			valueNumber = typeof msg.value === "number" ? msg.value : Number(msg.value);
			if (Number.isNaN(valueNumber)) {
				valueNumber = null;
				valueText = String(msg.value);
			}
			break;
		case "boolean":
			valueBoolean = typeof msg.value === "boolean" ? msg.value : String(msg.value).toLowerCase() === "true";
			break;
		case "enum":
			valueText = String(msg.value);
			break;
		case "string":
		default:
			valueText = String(msg.value);
			break;
	}

	return {
		device_id: msg.deviceId,
		sensor_id: msg.sensorId,
		ts: msg.ts,
		seq: msg.seq,
		type: msg.type,
		value_type: msg.valueType,
		value_number: valueNumber,
		value_boolean: valueBoolean,
		value_text: valueText,
		unit: msg.unit ?? null,
		location: msg.location ?? null
	};
}

async function insertTelemetryRow(row: ReturnType<typeof mapTelemetryToDb>): Promise<void> {
	await query(Sql.insertTelemetry, [
		row.device_id,
		row.sensor_id,
		row.ts,
		row.seq,
		row.type,
		row.value_type,
		row.value_number,
		row.value_boolean,
		row.value_text,
		row.unit,
		row.location
	]);
}


export async function runTimescaleWriter(queueItem: unknown, context: InvocationContext): Promise<void> {
	// Ensure config is loaded (no direct env reads here).
	loadConfig();

	const logger = createLogger(context);

	const items = parseQueueMessages<unknown>(queueItem);
	if (items.length === 0) {
		logger.info("timescale-writer: empty or unparsable queue message");
		return;
	}

	let inserted = 0;
	let failed = 0;

	for (const item of items) {
		try {
			const row = mapTelemetryToDb(item as TelemetryMessage);
			// Guard against NaN seq

			await insertTelemetryRow(row);
			inserted++;

			logger.debug(
				`timescale-writer: inserted deviceId=${row.device_id} sensorId=${row.sensor_id} ts=${row.ts} valueType=${row.value_type} value=${row.value_text ?? row.value_number ?? row.value_boolean}`
			);
		} catch (err) {
			failed++;
			logger.error("timescale-writer: failed to insert telemetry", {
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	logger.info("timescale-writer: done", { inserted, failed, count: items.length });

	// If any failed, throw so the queue message will be retried.
	// Downstream insert is idempotent due to ON CONFLICT DO NOTHING.
	if (failed > 0) {
		throw new Error(`timescale-writer: failed ${failed}/${items.length} item(s)`);
	}
}