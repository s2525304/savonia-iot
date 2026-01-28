import type { InvocationContext } from "@azure/functions";
import { z } from "zod";

import { query } from "../shared/db";
import { createLogger } from "../shared/log";

// NOTE:
// This function is intended to be used as the handler for an IoT Hub/Event Hub trigger.
// It accepts either a single message or a batch (array) of messages.

export interface TimescaleWriterResult {
	inserted: number;
	failed: number;
}

const TelemetrySchema = z.object({
	schemaVersion: z.literal(1),
	deviceId: z.string(),
	sensorId: z.string(),
	ts: z.string(),
	seq: z.number().int().nonnegative(),
	type: z.string(),
	valueType: z.enum(["number", "boolean", "string", "enum"]),
	value: z.union([z.number(), z.boolean(), z.string()]),
	unit: z.string().optional(),
	location: z.string().optional()
});

// Helper: normalize unknown event hub payload to an array of unknown messages
function normalizeBatch(event: unknown): unknown[] {
	if (Array.isArray(event)) {
		return event;
	}
	return [event];
}

// Helper: try to parse an Event Hub message into a JS object
// Event Hub trigger can deliver:
// - already-parsed object
// - string
// - Buffer/Uint8Array
function parseBodyToObject(body: unknown): unknown {
	if (body == null) return body;

	// If it's already an object (most common in local tests)
	if (typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
		return body;
	}

	if (typeof body === "string") {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}

	// Buffer or Uint8Array
	if (Buffer.isBuffer(body)) {
		const s = body.toString("utf8");
		try {
			return JSON.parse(s);
		} catch {
			return s;
		}
	}
	if (body instanceof Uint8Array) {
		const s = Buffer.from(body).toString("utf8");
		try {
			return JSON.parse(s);
		} catch {
			return s;
		}
	}

	return body;
}

// Map telemetry message to DB columns
function mapTelemetryToDb(msg: {
	deviceId: string;
	sensorId: string;
	ts: string;
	seq: number;
	type: string;
	unit?: string;
	location?: string;
	valueType: "number" | "boolean" | "enum" | "string";
	value: unknown;
}): {
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

	const batch = normalizeBatch(event);
	logger.info(`timescale-writer: received ${batch.length} event(s)`);

	let inserted = 0;
	let failed = 0;

	for (const item of batch) {
		try {
			const obj = parseBodyToObject(item);

			// Validate + normalize
			const parsed = TelemetrySchema.safeParse(obj);
			if (!parsed.success) {
				failed++;
				// Keep validation logs at debug to avoid log spam
				const issues = parsed.error.issues
					.map(issue => `${issue.path.map(p => String(p)).join(".") || "<root>"}: ${issue.message}`)
					.join("; ");
				logger.debug(`timescale-writer: telemetry validation failed: ${issues}`);
				continue;
			}

			const msg = parsed.data;
			const row = mapTelemetryToDb({
				deviceId: msg.deviceId,
				sensorId: msg.sensorId,
				ts: msg.ts,
				seq: msg.seq,
				type: msg.type,
				unit: msg.unit,
				location: msg.location,
				valueType: msg.valueType,
				value: msg.value
			});

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