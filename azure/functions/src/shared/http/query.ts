

//
// Small utilities for parsing HTTP query parameters in Azure Functions (Node).
//
// Goals:
// - Centralize parsing/validation for common query params (from/to/limit/cursor/etc.)
// - Provide a consistent way to support `format=csv` (and Accept: text/csv)
// - Keep dependencies minimal (no env access here; endpoints call config/loadConfig)

import type { HttpRequest } from "@azure/functions";

export class QueryError extends Error {
	public readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "QueryError";
		this.status = status;
	}
}

export type Cursor = {
	afterTs: string; // ISO string
	afterSeq: number;
};

export type TimeRange = {
	from: Date;
	to: Date;
};

function getHeader(req: HttpRequest, name: string): string | undefined {
	// Azure Functions headers are typically case-insensitive.
	const h = req.headers?.get?.(name);
	if (typeof h === "string" && h.length > 0) return h;

	// Fallback for older shapes
	const anyReq = req as unknown as { headers?: Record<string, string | undefined> };
	const direct = anyReq.headers?.[name] ?? anyReq.headers?.[name.toLowerCase()] ?? anyReq.headers?.[name.toUpperCase()];
	return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

/** Read a query param either from `req.query` or from the URL string. */
export function getQueryParam(req: HttpRequest, key: string): string | undefined {
	const anyReq = req as unknown as { query?: Record<string, string | undefined>; url?: string };
	const v = anyReq.query?.[key];
	if (typeof v === "string" && v.length > 0) return v;

	// URLSearchParams fallback
	if (typeof anyReq.url === "string" && anyReq.url.length > 0) {
		try {
			const u = new URL(anyReq.url);
			const p = u.searchParams.get(key);
			return p === null ? undefined : p;
		} catch {
			// ignore
		}
	}

	return undefined;
}

export function getString(req: HttpRequest, key: string): string | undefined {
	const v = getQueryParam(req, key);
	if (v === undefined) return undefined;
	const trimmed = v.trim();
	return trimmed.length ? trimmed : undefined;
}

export function requireString(req: HttpRequest, key: string): string {
	const v = getString(req, key);
	if (!v) throw new QueryError(`Missing required query parameter: ${key}`);
	return v;
}

export function getInt(req: HttpRequest, key: string): number | undefined {
	const v = getString(req, key);
	if (v === undefined) return undefined;
	if (!/^-?\d+$/.test(v)) throw new QueryError(`Invalid integer for '${key}'`);
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) throw new QueryError(`Invalid integer for '${key}'`);
	return n;
}

export function getPositiveInt(req: HttpRequest, key: string): number | undefined {
	const n = getInt(req, key);
	if (n === undefined) return undefined;
	if (n <= 0) throw new QueryError(`'${key}' must be > 0`);
	return n;
}

export function getBoolean(req: HttpRequest, key: string): boolean | undefined {
	const v = getString(req, key);
	if (v === undefined) return undefined;
	const s = v.toLowerCase();
	if (s === "true" || s === "1" || s === "yes") return true;
	if (s === "false" || s === "0" || s === "no") return false;
	throw new QueryError(`Invalid boolean for '${key}' (use true/false)`);
}

export function getEnum<T extends readonly string[]>(
	req: HttpRequest,
	key: string,
	allowed: T
): T[number] | undefined {
	const v = getString(req, key);
	if (v === undefined) return undefined;
	if ((allowed as readonly string[]).includes(v)) return v as T[number];
	throw new QueryError(`Invalid value for '${key}'. Allowed: ${allowed.join(", ")}`);
}

export function getIsoDate(req: HttpRequest, key: string): Date | undefined {
	const v = getString(req, key);
	if (v === undefined) return undefined;

	// Accept ISO 8601 or milliseconds since epoch.
	let d: Date;
	if (/^\d+$/.test(v)) {
		d = new Date(Number.parseInt(v, 10));
	} else {
		d = new Date(v);
	}

	if (Number.isNaN(d.getTime())) throw new QueryError(`Invalid date for '${key}' (use ISO 8601)`);
	return d;
}

/**
 * Parse (from,to) with sane defaults:
 * - If both missing: last 24 hours (to=now)
 * - If only from: to=now
 * - If only to: from=to-24h
 */
export function parseTimeRange(req: HttpRequest, opts?: { defaultHours?: number }): TimeRange {
	const defaultHours = opts?.defaultHours ?? 24;

	const from = getIsoDate(req, "from");
	const to = getIsoDate(req, "to");

	if (!from && !to) {
		const end = new Date();
		const start = new Date(end.getTime() - defaultHours * 60 * 60 * 1000);
		return { from: start, to: end };
	}

	if (from && !to) {
		return { from, to: new Date() };
	}

	if (!from && to) {
		const start = new Date(to.getTime() - defaultHours * 60 * 60 * 1000);
		return { from: start, to };
	}

	// both present
	if (!from || !to) throw new QueryError("Invalid time range");
	if (from.getTime() > to.getTime()) throw new QueryError("'from' must be <= 'to'");
	return { from, to };
}

/**
 * Parse `limit` with bounds.
 */
export function parseLimit(req: HttpRequest, opts?: { defaultLimit?: number; maxLimit?: number }): number {
	const def = opts?.defaultLimit ?? 1000;
	const max = opts?.maxLimit ?? 5000;
	const n = getPositiveInt(req, "limit") ?? def;
	return Math.min(n, max);
}

/**
 * Cursor-based pagination: afterTs + afterSeq.
 * Both must be present together if either is present.
 */
export function parseCursor(req: HttpRequest): Cursor | undefined {
	const afterTs = getString(req, "afterTs") ?? getString(req, "cursorAfterTs");
	const afterSeq = getInt(req, "afterSeq") ?? getInt(req, "cursorAfterSeq");

	if (afterTs === undefined && afterSeq === undefined) return undefined;
	if (afterTs === undefined || afterSeq === undefined) {
		throw new QueryError("Cursor requires both afterTs and afterSeq");
	}

	// Validate timestamp string quickly.
	const d = new Date(afterTs);
	if (Number.isNaN(d.getTime())) throw new QueryError("Invalid afterTs (use ISO 8601)");
	if (afterSeq < 0) throw new QueryError("afterSeq must be >= 0");

	return { afterTs: d.toISOString(), afterSeq };
}

/**
 * Should the response be CSV?
 * - `?format=csv` OR
 * - `Accept: text/csv`
 */
export function wantsCsv(req: HttpRequest): boolean {
	const format = getString(req, "format")?.toLowerCase();
	if (format === "csv") return true;

	const accept = (getHeader(req, "accept") ?? "").toLowerCase();
	return accept.includes("text/csv");
}

/**
 * If you need to know the requested format explicitly.
 */
export function getResponseFormat(req: HttpRequest): "json" | "csv" {
	return wantsCsv(req) ? "csv" : "json";
}