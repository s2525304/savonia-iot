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

export async function getMeasurements(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

	const sql = `
		SELECT
			ts,
			seq,
			type,
			value_type AS "valueType",
			CASE
				WHEN value_type = 'number'  THEN to_jsonb(value_number)
				WHEN value_type = 'boolean' THEN to_jsonb(value_boolean)
				ELSE to_jsonb(value_text)
			END AS value,
			unit,
			location
		FROM telemetry
		WHERE device_id = $1
			AND sensor_id = $2
			AND ts >= $3::timestamptz
			AND ts <= $4::timestamptz
			${whereCursorSql}
		ORDER BY ts ASC, seq ASC
		LIMIT $${limitParamIdx}::int
	`;

	const safeParams = values.map(v => ({
		type: v === null ? "null" : Array.isArray(v) ? "array" : typeof v,
		preview: typeof v === "string" ? v.slice(0, 80) : typeof v === "number" || typeof v === "boolean" ? v : undefined
	}));
	log.debug("measurements.get: sql", { sql, params: safeParams });

	try {
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

		log.error("measurements.get: query failed", {
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
			jsonBody: { error: "Failed to fetch measurements" }
		};
	}
}