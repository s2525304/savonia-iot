import { query } from "../../shared/db";
import { Sql } from "../../shared/sql";
import { httpEndpoint, badRequest } from "../../shared/http/endpoint";
import {
	parseTimeRange,
	parseLimit,
	parseCursor
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

export const getHourly = httpEndpoint(async ({ req, log, asCsv }) => {
	const deviceId = req.params.deviceId;
	const sensorId = req.params.sensorId;
	if (!deviceId || !sensorId) {
		return badRequest("Missing route params: deviceId and sensorId are required");
	}

	const { from, to } = parseTimeRange(req, { defaultHours: DEFAULT_RANGE_HOURS });
	const limit = parseLimit(req, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

	const cursor = parseCursor(req);
	const hasAfter = cursor !== undefined;
	const afterTs = cursor ? new Date(cursor.afterTs) : undefined;

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
		afterTs: afterTs ? iso(afterTs) : undefined
	});

	// Fetch one extra to know if there are more results.
	const pageSize = limit + 1;

	// Cursor pagination:
	// - hourly view has only the bucket timestamp as a natural cursor
	// - shared cursor parser requires afterSeq; we accept it but ignore it here
	const values: unknown[] = [deviceId, sensorId, iso(from), iso(to)];
	let whereCursorSql = "";
	if (hasAfter && cursor) {
		values.push(cursor.afterTs);
		whereCursorSql = "AND bucket > $5::timestamptz";
	}

	values.push(pageSize);
	const limitParamIdx = values.length;

	const sql = Sql.buildSelectHourlyAggregates(
		whereCursorSql ? `\n\t\t${whereCursorSql}` : "",
		limitParamIdx
	);

	log.debug("hourly.get: sql", {
		name: "buildSelectHourlyAggregates",
		params: values.length,
		hasCursor: Boolean(whereCursorSql)
	});

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
		const e = err instanceof Error ? err : new Error(String(err));
		const anyE = e as unknown as Record<string, unknown>;
		const get = (k: string): unknown => (k in anyE ? anyE[k] : undefined);

		log.error("hourly.get: query failed", {
			name: e.name,
			message: e.message,
			code: get("code"),
			detail: get("detail"),
			hint: get("hint"),
			query: {
				deviceId,
				sensorId,
				from: iso(from),
				to: iso(to),
				limit,
				afterTs: afterTs ? iso(afterTs) : undefined
			}
		});

		return {
			status: 500,
			jsonBody: { error: "Failed to fetch hourly aggregates" }
		};
	}
}, { name: "hourly.get" });
