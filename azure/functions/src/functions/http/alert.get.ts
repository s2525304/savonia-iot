import type { HttpResponseInit } from "@azure/functions";

import { query } from "../../shared/db";
import { Sql } from "../../shared/sql";
import { httpEndpoint } from "../../shared/http/endpoint";
import { getString, parseLimit } from "../../shared/http/query";
import { csvResponse, makeCsvFilename, toCsvWithMeta, type CsvValue } from "../../shared/http/csv";

// GET /api/alert?device_id&sensor_id&open&limit&format
//
// Query params:
// - device_id (optional)
// - sensor_id (optional; only meaningful with device_id)
// - open (optional boolean; if true, return only currently open alerts)
// - limit (optional; defaults to safe value; capped)
// - format (optional; "csv" to return CSV, default JSON)

// Semantics:
// - If open=true: list only currently open alerts.
// - Else: list latest alerts, with open alerts prioritized before closed.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function badRequest(message: string): HttpResponseInit {
	return {
		status: 400,
		jsonBody: { error: message }
	};
}

function toCsvValue(v: unknown): CsvValue {
	if (v === null || v === undefined) return "";
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
	if (v instanceof Date) return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function parseBool(v: string | undefined): boolean | undefined {
	if (v === undefined) return undefined;
	const s = v.trim().toLowerCase();
	if (s === "" ) return undefined;
	if (["1", "true", "yes", "y", "on"].includes(s)) return true;
	if (["0", "false", "no", "n", "off"].includes(s)) return false;
	throw new Error("Invalid boolean");
}

type AlertApiRow = {
	id: number;
	triggerId: number;
	deviceId: string;
	sensorId: string;
	startTs: string;
	endTs: string | null;
	reason: string | null;
	context: unknown;
	createdAt: string;
	updatedAt: string;
	triggerName: string | null;
	minValue: number | null;
	maxValue: number | null;
	triggerEnabled: boolean;
};

export const getAlert = httpEndpoint(async ({ req, log }) => {
	const deviceId = getString(req, "device_id")?.trim();
	const sensorId = getString(req, "sensor_id")?.trim();
	const openStr = getString(req, "open");

	const format = (getString(req, "format") ?? "").trim().toLowerCase();
	const asCsv = format === "csv";

	let openOnly: boolean | undefined;
	try {
		openOnly = parseBool(openStr);
	} catch {
		return badRequest("Invalid open. Use true/false (or 1/0)");
	}

	// If sensor_id is provided without device_id, we reject to avoid ambiguous queries.
	if (sensorId && !deviceId) {
		return badRequest("sensor_id requires device_id");
	}

	const limit = parseLimit(req, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

	log.debug("alert.get: request", {
		deviceId: deviceId ?? undefined,
		sensorId: sensorId ?? undefined,
		openOnly: openOnly ?? false,
		limit
	});

	let sql: string;
	let params: unknown[];

	if (openOnly) {
		if (deviceId && sensorId) {
			sql = Sql.selectOpenAlertsByDeviceSensor;
			params = [deviceId, sensorId, limit];
		} else if (deviceId) {
			sql = Sql.selectOpenAlertsByDevice;
			params = [deviceId, limit];
		} else {
			sql = Sql.selectOpenAlertsAll;
			params = [limit];
		}
	} else {
		// Latest alerts; open alerts have priority.
		if (deviceId && sensorId) {
			sql = Sql.selectLatestAlertsByDeviceSensor;
			params = [deviceId, sensorId, limit];
		} else if (deviceId) {
			sql = Sql.selectLatestAlertsByDevice;
			params = [deviceId, limit];
		} else {
			sql = Sql.selectLatestAlertsAll;
			params = [limit];
		}
	}

	const res = await query(sql, params);
	const rows = (res.rows ?? []) as AlertApiRow[];

	if (asCsv) {
		const meta = {
			deviceId: deviceId ?? "",
			sensorId: sensorId ?? "",
			openOnly: Boolean(openOnly),
			limit,
			count: rows.length
		};

		type Row = AlertApiRow;
		const columns = [
			{ header: "id", accessor: (r: Row) => r.id },
			{ header: "triggerId", accessor: (r: Row) => r.triggerId },
			{ header: "deviceId", accessor: (r: Row) => r.deviceId },
			{ header: "sensorId", accessor: (r: Row) => r.sensorId },
			{ header: "startTs", accessor: (r: Row) => r.startTs },
			{ header: "endTs", accessor: (r: Row) => r.endTs ?? "" },
			{ header: "reason", accessor: (r: Row) => r.reason ?? "" },
			{ header: "triggerName", accessor: (r: Row) => r.triggerName ?? "" },
			{ header: "minValue", accessor: (r: Row) => r.minValue ?? "" },
			{ header: "maxValue", accessor: (r: Row) => r.maxValue ?? "" },
			{ header: "triggerEnabled", accessor: (r: Row) => r.triggerEnabled },
			{ header: "createdAt", accessor: (r: Row) => r.createdAt },
			{ header: "updatedAt", accessor: (r: Row) => r.updatedAt },
			{ header: "context", accessor: (r: Row) => toCsvValue(r.context) }
		] as const;

		const csv = toCsvWithMeta(meta, rows, columns);
		const filename = makeCsvFilename([
			"alerts",
			deviceId ?? "all",
			sensorId ?? "all",
			openOnly ? "open" : "latest"
		]);
		return csvResponse(csv, filename);
	}

	// The queries already order results so that open alerts come first for "latest".
	return {
		status: 200,
		jsonBody: {
			deviceId: deviceId ?? null,
			sensorId: sensorId ?? null,
			openOnly: Boolean(openOnly),
			limit,
			count: rows.length,
			items: rows,
			format: asCsv ? "csv" : "json",
		}
	};
}, { name: "alert.get" });