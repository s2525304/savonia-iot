import { type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

import { query } from "../../shared/db";
import { createLogger } from "../../shared/log";
import { verifyApiKey } from "../../shared/http/auth";
import { wantsCsv } from "../../shared/http/query";
import { toCsv, type CsvColumn } from "../../shared/http/csv";

type DeviceDto = {
	deviceId: string;
	location?: string;
};

export async function getDevices(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
	const log = createLogger(context);

	const auth = verifyApiKey(_request, context);
	if (!auth.ok) {
		return auth.response;
	}

	try {
		// Keep SQL as a single string so TypeScript/linters won't complain about invalid SQL.
		// Assumes a `devices` table with at least: device_id (text) and optional location (text).
        const sql =
            "SELECT DISTINCT ON (device_id) " +
            "  device_id AS \"deviceId\", " +
            "  location AS \"location\" " +
            "FROM telemetry " +
            "ORDER BY device_id, ts DESC";

        const res = await query<DeviceDto>(sql);

		if (wantsCsv(_request)) {
			const columns: CsvColumn<DeviceDto>[] = [
				{ header: "deviceId", accessor: (r: DeviceDto) => r.deviceId },
				{ header: "location", accessor: (r: DeviceDto) => r.location ?? "" }
			];

			const csv = toCsv(res.rows, columns);
			return {
				status: 200,
				headers: {
					"content-type": "text/csv; charset=utf-8"
				},
				body: csv
			};
		}

		return {
			status: 200,
			jsonBody: {
				devices: res.rows
			}
		};
	} catch (err) {
		log.error("devices.get failed", { err: err instanceof Error ? { message: err.message, stack: err.stack } : err });
		return {
			status: 500,
			jsonBody: {
				error: "Failed to fetch devices"
			}
		};
	}
}
