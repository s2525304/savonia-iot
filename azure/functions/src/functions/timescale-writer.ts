import type { InvocationContext } from "@azure/functions";
import { query } from "../shared/db";
import { createLogger } from "../shared/log";
import { parseTelemetryBatch } from "../shared/iothub/parseTelemetry";
import type { TelemetryMessage } from "../shared/iothub/telemetry";

export interface TimescaleWriterResult {
	inserted: number;
	failed: number;
}

// Map telemetry message to DB columns
function mapTelemetryToDb(msg: TelemetryMessage): {
	device_id: string;
	sensor_id: string;
	ts: string;
	seq: number | null;
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
	// Keep SQL inline and fully parameterized.
	// Assumes the table exists with matching columns.
	// Columns used:
	// - device_id text
	// - sensor_id text
	// - ts timestamptz
	// - seq bigint null
	// - type text
	// - value_type text
	// - value_number double precision null
	// - value_boolean boolean null
	// - value_text text null
	// - unit text null
	// - location text null
	await query(
		`INSERT INTO telemetry (
				device_id,
				sensor_id,
				ts,
				seq,
				type,
				value_type,
				value_number,
				value_boolean,
				value_text,
				unit,
				location
		)
		VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT DO NOTHING`,
		[
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
		]
	);
}

export async function runTimescaleWriter(event: unknown, context: InvocationContext): Promise<TimescaleWriterResult> {
	const logger = createLogger(context);

	const { ok, bad } = parseTelemetryBatch(event, context);
	logger.info(`timescale-writer: received ${Array.isArray(event) ? event.length : 1} event(s)`);
	logger.info(`timescale-writer: validated ${ok.length} telemetry message(s), failed ${bad.length}`);

	let inserted = 0;
	let failed = bad.length;

	for (const msg of ok) {
		try {
			const row = mapTelemetryToDb(msg);
			await insertTelemetryRow(row);
			inserted++;

			// Keep per-row logs at debug; info-level logs get noisy fast.
			logger.debug(
				`timescale-writer: inserted deviceId=${row.device_id} sensorId=${row.sensor_id} ts=${row.ts} valueType=${row.value_type} value=${row.value_text ?? row.value_number ?? row.value_boolean}`
			);
		} catch (err) {
			failed++;
			logger.error(`timescale-writer: failed to process message: ${(err as Error).message}`);
		}
	}

	logger.info(`timescale-writer: done inserted=${inserted} failed=${failed}`);
	return { inserted, failed };
}