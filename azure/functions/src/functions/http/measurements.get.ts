import type { HttpResponseInit } from "@azure/functions";

import { query } from "../../shared/db";
import { Sql } from "../../shared/sql";
import { httpEndpoint } from "../../shared/http/endpoint";
import {
    parseTimeRange,
    parseLimit,
    parseCursor
} from "../../shared/http/query";
import { csvResponse, toCsvWithMeta, type CsvValue } from "../../shared/http/csv";

// GET /devices/{deviceId}/sensors/{sensorId}/measurements?from&to&limit&afterTs&afterSeq
//
// Notes on "too many rows":
// - We require a time window (from/to). If missing, we default to a safe recent range.
// - We enforce a hard max `limit` to prevent accidental full-table reads.
// - We support cursor pagination (afterTs/afterSeq) for large result sets.

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const DEFAULT_RANGE_HOURS = 24;
const MAX_RANGE_DAYS = 31;

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
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;

	// Fall back to JSON for objects/arrays.
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export const getMeasurements = httpEndpoint(async ({ req, log, asCsv }) => {
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
	const afterSeq = cursor?.afterSeq;

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

	log.debug("measurements.get: effective query window", {
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

	// Use a stable sort for pagination.
	// We also select a normalized `value` field so the UI can show it directly.
	const values: unknown[] = [deviceId, sensorId, iso(from), iso(to)];
	let whereCursorSql = "";

	if (hasAfter && cursor) {
		values.push(cursor.afterTs, cursor.afterSeq);
		whereCursorSql = "AND (ts, seq) > ($5::timestamptz, $6::bigint)";
	}

	values.push(pageSize);
	const limitParamIdx = values.length;

	const sql = Sql.buildSelectTelemetryMeasurements(
		whereCursorSql ? `\n\t\t${whereCursorSql}` : "",
		limitParamIdx
	);

	log.debug("measurements.get: sql", {
		name: "buildSelectTelemetryMeasurements",
		params: values.length,
		hasCursor: Boolean(whereCursorSql)
	});

	const res = await query(sql, values);
	const rows = res.rows as Array<{
		ts: string;
		seq: string | number;
		type: string;
		valueType: "number" | "boolean" | "string" | "enum";
		value: unknown;
		unit?: string | null;
		location?: string | null;
	}>;

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;

	const meta = items.length > 0 ? {
		type: items[0].type,
		valueType: items[0].valueType,
		unit: items[0].unit ?? undefined,
		location: items[0].location ?? undefined
	} : undefined;

	const compactItems = items.map(r => ([
		r.ts,
		typeof r.seq === "string" ? Number(r.seq) : r.seq,
		r.value
	] as const));

	let nextCursor: { afterTs: string; afterSeq: number } | undefined;
	if (hasMore && items.length > 0) {
		const last = items[items.length - 1];
		nextCursor = {
			afterTs: last.ts,
			afterSeq: typeof last.seq === "string" ? Number(last.seq) : last.seq
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
		type CompactRow = readonly [string, number, unknown];
		const columns = [
			{ header: "ts", accessor: (r: CompactRow) => r[0] },
			{ header: "seq", accessor: (r: CompactRow) => r[1] },
			{ header: "value", accessor: (r: CompactRow) => toCsvValue(r[2]) }
		] as const;

		const csv = toCsvWithMeta(csvMeta, compactItems, columns);
		return csvResponse(csv, "measurements.csv");
	}

	return {
		status: 200,
		jsonBody: {
			deviceId,
			sensorId,
			...(meta ?? {}),
			from: iso(from),
			to: iso(to),
			limit,
			hasMore,
			nextCursor,
			items: compactItems
		}
	};
}, { name: "measurements.get" });