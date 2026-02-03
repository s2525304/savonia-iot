import type { HttpResponseInit } from "@azure/functions";

import { query } from "../../shared/db";
import { httpEndpoint } from "../../shared/http/endpoint";
import { getString } from "../../shared/http/query";
import { Sql } from "../../shared/sql";

// GET /devices/{deviceId}/sensors/{sensorId}/trigger?min&max (query params are optional)
//
// Behavior:
// - If neither min nor max is provided: return current trigger (or null)
// - If min and/or max is provided: upsert trigger for the sensor
//   - Missing side is cleared (set to NULL) on update
// - Only supported for numeric sensors

function badRequest(message: string): HttpResponseInit {
	return {
		status: 400,
		jsonBody: { error: message }
	};
}

function parseOptionalNumberParam(v: string | undefined, name: string): number | undefined {
	if (v === undefined) return undefined;
	const s = v.trim();
	if (s.length === 0) return undefined;

	// Support both dot and comma decimals (UI often sends dot, but be forgiving)
	const normalized = s.replace(",", ".");
	const n = Number(normalized);
	if (!Number.isFinite(n)) {
		throw new Error(`Invalid number for '${name}'`);
	}
	return n;
}
async function ensureNumericSensor(deviceId: string, sensorId: string): Promise<"number" | "other" | "missing"> {
	const res = await query(Sql.selectSensorValueType, [deviceId, sensorId]);
	// Debug: inspect what DB returned for value type lookup
	// NOTE: keep this at debug/info level; it is not sensitive.
	// eslint-disable-next-line no-console
	console.info("trigger.get: selectSensorValueType", {
		deviceId,
		sensorId,
		rowCount: res.rows?.length ?? 0,
		firstRow: res.rows?.[0] ?? null
	});
	const row = res.rows?.[0] as { valueType?: string } | undefined;
	if (!row) return "missing";

	const vt = (row.valueType ?? "").toLowerCase().trim();
	// Accept common DB/value-type representations for numeric sensors.
	const numericTypes = new Set([
		"number",
		"numeric",
		"decimal",
		"float",
		"double",
		"real",
		"int",
		"integer"
	]);

	// eslint-disable-next-line no-console
	console.info("trigger.get: value_type normalized", {
		deviceId,
		sensorId,
		value_type_raw: row.valueType ?? null,
		value_type_norm: vt,
		isNumeric: numericTypes.has(vt)
	});

	return numericTypes.has(vt) ? "number" : "other";
}

type TriggerRow = {
	minValue: number | null;
	maxValue: number | null;
	enabled?: boolean;
	updatedAt?: string;
};

async function readTrigger(deviceId: string, sensorId: string) {
	const res = await query(Sql.selectAlertTrigger, [deviceId, sensorId]);
	const row = res.rows?.[0] as TriggerRow | undefined;
	if (!row) return null;

	return {
		...(row.minValue === null ? {} : { min: row.minValue }),
		...(row.maxValue === null ? {} : { max: row.maxValue }),
	};
}


async function upsertTrigger(deviceId: string, sensorId: string, min: number | null, max: number | null): Promise<{ min?: number; max?: number } | null> {
	// If both are NULL, there is no trigger to keep.
	// Delete any existing trigger.
	if (min === null && max === null) {
		await query(Sql.deleteAlertTrigger, [deviceId, sensorId]);
		return null;
	}

	await query(Sql.upsertAlertTrigger, [deviceId, sensorId, min, max]);

	return readTrigger(deviceId, sensorId);
}

export const getTrigger = httpEndpoint(async ({ req, log }) => {
	const deviceId = req.params.deviceId;
	const sensorId = req.params.sensorId;
	if (!deviceId || !sensorId) {
		return badRequest("Missing route params: deviceId and sensorId are required");
	}

	log.info("trigger.get: request", {
		deviceId,
		sensorId,
		method: req.method,
		min: getString(req, "min") ?? null,
		max: getString(req, "max") ?? null
	});

	// Read query params
	const minStr = getString(req, "min");
	const maxStr = getString(req, "max");

	let min: number | undefined;
	let max: number | undefined;
	try {
		min = parseOptionalNumberParam(minStr, "min");
		max = parseOptionalNumberParam(maxStr, "max");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return badRequest(msg);
	}

	const willUpdate = min !== undefined || max !== undefined;

	// Only numeric sensors can have triggers.
	const kind = await ensureNumericSensor(deviceId, sensorId);
	log.info("trigger.get: sensor kind", { deviceId, sensorId, kind });
	if (kind === "missing") {
		return {
			status: 404,
			jsonBody: {
				error: "Sensor not found for deviceId/sensorId"
			}
		};
	}
	if (kind !== "number") {
		return {
			status: 400,
			jsonBody: {
				error: "Triggers are only supported for numeric sensors",
				kind
			}
		};
	}

	if (!willUpdate) {
		const trigger = await readTrigger(deviceId, sensorId);
		return {
			status: 200,
			jsonBody: {
				deviceId,
				sensorId,
				alertTrigger: trigger
			}
		};
	}

	// Update semantics:
	// - if min is provided, set it; otherwise clear it
	// - if max is provided, set it; otherwise clear it
	const minDb = min === undefined ? null : min;
	const maxDb = max === undefined ? null : max;

	if (minDb !== null && maxDb !== null && minDb > maxDb) {
		return badRequest("Invalid trigger: min must be <= max");
	}

	log.info("trigger.get: upsert", {
		deviceId,
		sensorId,
		min: minDb,
		max: maxDb
	});

	const trigger = await upsertTrigger(deviceId, sensorId, minDb, maxDb);

	return {
		status: 200,
		jsonBody: {
			deviceId,
			sensorId,
			alertTrigger: trigger
		}
	};
}, { name: "trigger.get" });