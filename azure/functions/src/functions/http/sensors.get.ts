import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import { createLogger } from "../../shared/log";
import { verifyApiKey } from "../../shared/http/auth";
import { wantsCsv } from "../../shared/http/query";
import { query } from "../../shared/db";
import { toCsv, type CsvColumn } from "../../shared/http/csv";

export type SensorDto = {
	sensorId: string;
	type: string;
	unit: string | null;
	location: string | null;
	firstTs: string; // ISO
	lastTs: string;  // ISO
	count: number;
};

function badRequest(message: string): HttpResponseInit {
	return {
		status: 400,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ error: message })
	};
}

/**
 * GET /devices/{deviceId}/sensors
 *
 * Returns the list of sensors that have produced telemetry for a given device.
 */
export async function getSensors(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
	const log = createLogger(context);

	// API key auth (shared across HTTP endpoints)
	const auth = verifyApiKey(req);
	if (!auth.ok) return auth.response;

	const deviceId = (req.params?.deviceId ?? "").trim();
	if (!deviceId) {
		return badRequest("Missing route param: deviceId");
	}

	// Distinct sensors for the device, plus some useful metadata.
	// We aggregate from telemetry to avoid introducing a separate sensor table.
	const sql = `
		SELECT
			sensor_id AS "sensorId",
			MIN(type) AS "type",
			MIN(unit) AS "unit",
			MIN(location) AS "location",
			MIN(ts) AS "firstTs",
			MAX(ts) AS "lastTs",
			COUNT(*)::bigint AS "count"
		FROM telemetry
		WHERE device_id = $1
		GROUP BY sensor_id
		ORDER BY sensor_id;
	`;

	try {
		const res = await query<SensorDto>(sql, [deviceId]);

		const csvColumns: CsvColumn<SensorDto>[] = [
			{ header: "sensorId", accessor: r => r.sensorId },
			{ header: "type", accessor: r => r.type },
			{ header: "unit", accessor: r => r.unit },
			{ header: "location", accessor: r => r.location },
			{ header: "firstTs", accessor: r => r.firstTs },
			{ header: "lastTs", accessor: r => r.lastTs },
			{ header: "count", accessor: r => r.count },
		];

		log.info("sensors.get: ok", { deviceId, sensors: res.rows.length });
		if (wantsCsv(req)) {
			return {
				status: 200,
				headers: { "content-type": "text/csv; charset=utf-8" },
				body: toCsv(res.rows, csvColumns)
			};
		}
		return {
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceId, sensors: res.rows })
		};
	} catch (err) {
		log.error("sensors.get: db query failed", { deviceId, err: String(err) });
		return {
			status: 500,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ error: "Database query failed" })
		};
	}
}