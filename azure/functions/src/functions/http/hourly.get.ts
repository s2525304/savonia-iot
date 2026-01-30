import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import { query } from "../../shared/db";
import { createLogger } from "../../shared/log";
import { verifyApiKey } from "../../shared/http/auth";
import {
	parseTimeRange,
	parseLimit,
	parseCursor,
	wantsCsv
} from "../../shared/http/query";
import { csvResponse, toCsvWithMeta, type CsvValue, type CsvColumn } from "../../shared/http/csv";

// GET /devices/{deviceId}/sensors/{sensorId}/hourly?from&to&limit&afterTs&afterSeq
//
// Returns hourly aggregates from the materialized view `telemetry_hourly_avg`.
//
// Notes:
// - We accept the same query parameters as `measurements.get.ts` for consistency.
// - Cursor pagination uses `afterTs` as the last seen bucket timestamp.
//   `afterSeq` is accepted (and required by the shared cursor parser) but not used for hourly.

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const DEFAULT_RANGE_HOURS = 24;
const MAX_RANGE_DAYS = 366;

function iso(d: Date): string {
	return d.toISOString();
}

function badRequest(message: string): HttpResponseInit {
	return {
		status: 400,
		jsonBody: { error: message }
	};
}

function toCsvValue(v: unknown): CsvValue {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) return v;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;

	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export async function getHourly(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
	const log = createLogger(context);

	// API key auth (shared across HTTP endpoints)
	const auth = verifyApiKey(request, context);
	if (!auth.ok) return auth.response;

	const deviceId = request.params.deviceId;
	const sensorId = request.params.sensorId;
	if (!deviceId || !sensorId) {
		return badRequest("Missing route params: deviceId and sensorId are required");
	}

	const { from, to } = parseTimeRange(request, { defaultHours: DEFAULT_RANGE_HOURS });
	const limit = parseLimit(request, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

	const cursor = parseCursor(request);
	const hasAfter = cursor !== undefined;
	const afterTs = cursor ? new Date(cursor.afterTs) : undefined;
	const afterSeq = cursor?.afterSeq;

	const asCsv = wantsCsv(request);

	if (!from || !to) {
		return badRequest("Invalid from/to. Use ISO timestamps, e.g. 2026-01-29T12:00:00Z");
	}

	if (from.getTime() > to.getTime()) {
		return badRequest("Invalid range: from must be <= to");
	}

	// Hard cap range to prevent accidental huge reads.
	const maxRangeMs = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
	if (to.getTime() - from.getTime() > maxRangeMs) {
		return badRequest(`Time range too large. Max supported is ${MAX_RANGE_DAYS} days.`);
	}

	log.debug("hourly.get: effective query window", {
		deviceId,
		sensorId,
		from: iso(from),
		to: iso(to),
		limit,
		afterTs: afterTs ? iso(afterTs) : undefined,
		afterSeq
	});

	// Fetch one extra to know if there are more results.
	const pageSize = limit + 1;

	// Cursor pagination:
	// - hourly view has only the bucket timestamp as a natural cursor
	// - we still accept/require afterSeq (shared cursor parser), but ignore it here
	const values: unknown[] = [deviceId, sensorId, iso(from), iso(to)];
	let whereCursorSql = "";
	if (hasAfter && cursor) {
		values.push(cursor.afterTs);
		whereCursorSql = "AND bucket > $5::timestamptz";
	}

	values.push(pageSize);
	const limitParamIdx = values.length;

	const sql = `
		SELECT
			bucket,
			avg_value AS "avgValue",
			min_value AS "minValue",
			max_value AS "maxValue",
			samples
		FROM telemetry_hourly_avg
		WHERE device_id = $1
			AND sensor_id = $2
			AND bucket >= $3::timestamptz
			AND bucket <= $4::timestamptz
			${whereCursorSql}
		ORDER BY bucket ASC
		LIMIT $${limitParamIdx}::int
	`;

	const safeParams = values.map(v => ({
		type: v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
		preview: typeof v === "string" ? v.slice(0, 80) : typeof v === "number" || typeof v === "boolean" ? v : undefined
	}));
	log.debug("hourly.get: sql", { sql, params: safeParams });

	try {
		const res = await query(sql, values);
		const rows = res.rows as Array<{
			bucket: string;
			avgValue: string | number | null;
			minValue: string | number | null;
			maxValue: string | number | null;
			samples: string | number;
		}>;

		const hasMore = rows.length > limit;
		const items = hasMore ? rows.slice(0, limit) : rows;

		type CompactRow = readonly [string, number | null, number | null, number | null, number];
		const compactItems: CompactRow[] = items.map(r => {
			const asNum = (x: string | number | null): number | null => {
				if (x === null) return null;
				if (typeof x === "number") return Number.isFinite(x) ? x : null;
				const n = Number(x);
				return Number.isFinite(n) ? n : null;
			};

			const samples = typeof r.samples === "string" ? Number(r.samples) : r.samples;

			return [
				r.bucket,
				asNum(r.avgValue),
				asNum(r.minValue),
				asNum(r.maxValue),
				Number.isFinite(samples) ? samples : 0
			] as const;
		});

		let nextCursor: { afterTs: string; afterSeq: number } | undefined;
		if (hasMore && items.length > 0) {
			const last = items[items.length - 1];
			nextCursor = {
				afterTs: last.bucket,
				afterSeq: 0
			};
		}

		if (asCsv) {
			const csvMeta = {
				deviceId,
				sensorId,
				from: iso(from),
				to: iso(to),
				limit,
				hasMore,
				nextCursor: nextCursor ? JSON.stringify(nextCursor) : undefined
			};

			const columns: CsvColumn<CompactRow>[] = [
				{ header: "bucket", accessor: (r: CompactRow) => r[0] },
				{ header: "avg", accessor: (r: CompactRow) => toCsvValue(r[1]) },
				{ header: "min", accessor: (r: CompactRow) => toCsvValue(r[2]) },
				{ header: "max", accessor: (r: CompactRow) => toCsvValue(r[3]) },
				{ header: "samples", accessor: (r: CompactRow) => toCsvValue(r[4]) }
			];

			const csv = toCsvWithMeta(csvMeta, compactItems, columns);
			return csvResponse(csv, "hourly.csv");
		}

		return {
			status: 200,
			jsonBody: {
				deviceId,
				sensorId,
				from: iso(from),
				to: iso(to),
				limit,
				hasMore,
				nextCursor,
				items: compactItems
			}
		};
	} catch (err) {
		const describeError = (e: unknown): Record<string, unknown> => {
			if (e == null) return { err: e };
			if (e instanceof Error) {
				const anyE = e as unknown as Record<string, unknown>;
				const get = (k: string): unknown => (k in anyE ? anyE[k] : undefined);
				return {
					name: e.name,
					message: e.message,
					stack: e.stack,
					code: get("code"),
					detail: get("detail"),
					hint: get("hint"),
					where: get("where"),
					severity: get("severity"),
					position: get("position"),
					internalPosition: get("internalPosition"),
					internalQuery: get("internalQuery"),
					schema: get("schema"),
					table: get("table"),
					column: get("column"),
					constraint: get("constraint"),
					dataType: get("dataType"),
					file: get("file"),
					line: get("line"),
					routine: get("routine"),
					details: get("details")
				};
			}
			try {
				return { err: JSON.stringify(e) };
			} catch {
				return { err: String(e) };
			}
		};

		log.error("hourly.get: query failed", {
			...describeError(err),
			query: {
				deviceId,
				sensorId,
				from: iso(from),
				to: iso(to),
				limit,
				afterTs: afterTs ? iso(afterTs) : undefined,
				afterSeq
			}
		});

		return {
			status: 500,
			jsonBody: { error: "Failed to fetch hourly aggregates" }
		};
	}
}
