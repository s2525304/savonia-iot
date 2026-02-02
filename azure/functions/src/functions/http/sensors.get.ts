import type { HttpResponseInit } from "@azure/functions";

import { query } from "../../shared/db";
import { toCsv, type CsvColumn } from "../../shared/http/csv";
import { httpEndpoint, json, csvOk } from "../../shared/http/endpoint";
import { QueryError } from "../../shared/http/query";
import { Sql } from "../../shared/sql";

export type SensorDto = {
	sensorId: string;
	type: string;
	unit: string | null;
	location: string | null;
	firstTs: string; // ISO
	lastTs: string;  // ISO
	count: number;
};

/**
 * GET /devices/{deviceId}/sensors
 *
 * Returns the list of sensors that have produced telemetry for a given device.
 */
export const getSensors = httpEndpoint(async ({ req, log, asCsv }): Promise<HttpResponseInit> => {
	const deviceId = (req.params?.deviceId ?? "").trim();
	if (!deviceId) {
		throw new QueryError("Missing route param: deviceId");
	}

	const res = await query<SensorDto>(Sql.selectSensorsByDevice, [deviceId]);

	const csvColumns: CsvColumn<SensorDto>[] = [
		{ header: "sensorId", accessor: r => r.sensorId },
		{ header: "type", accessor: r => r.type },
		{ header: "unit", accessor: r => r.unit },
		{ header: "location", accessor: r => r.location },
		{ header: "firstTs", accessor: r => r.firstTs },
		{ header: "lastTs", accessor: r => r.lastTs },
		{ header: "count", accessor: r => r.count }
	];

	log.info("sensors.get: ok", { deviceId, sensors: res.rows.length });

	if (asCsv) {
		return csvOk(toCsv(res.rows, csvColumns));
	}

	return json(200, { deviceId, sensors: res.rows });
}, { name: "sensors.get" });