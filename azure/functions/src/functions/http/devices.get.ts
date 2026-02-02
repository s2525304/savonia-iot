import { type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

import { query } from "../../shared/db";
import { wantsCsv } from "../../shared/http/query";
import { toCsv, type CsvColumn } from "../../shared/http/csv";
import { Sql } from "../../shared/sql";
import { httpEndpoint } from "../../shared/http/endpoint";

type DeviceDto = {
	deviceId: string;
	location?: string;
};

export const getDevices = httpEndpoint(async ({ req, log, asCsv }) => {
	const res = await query<DeviceDto>(Sql.selectDistinctDevices);

	if (asCsv) {
		const columns: CsvColumn<DeviceDto>[] = [
			{ header: "deviceId", accessor: r => r.deviceId },
			{ header: "location", accessor: r => r.location ?? "" }
		];

		const csv = toCsv(res.rows, columns);
		return {
			status: 200,
			headers: { "content-type": "text/csv; charset=utf-8" },
			body: csv
		};
	}

	log.info("devices.get: ok", { devices: res.rows.length });
	return {
		status: 200,
		jsonBody: { devices: res.rows }
	};
}, { name: "devices.get" });
