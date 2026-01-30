// src/shared/http/csv.ts
//
// Common CSV utilities for Azure Functions HTTP endpoints.
//
// Goals:
// - Provide a single place to format CSV consistently across endpoints.
// - Keep dependencies minimal.
// - Make it easy for endpoints to return either JSON or CSV.
//
// Notes:
// - CSV is returned as UTF-8 text.
// - We include a UTF-8 BOM by default to make Excel/Sheets happier.

import type { HttpResponseInit } from "@azure/functions";

export type CsvValue = string | number | boolean | null | undefined | Date;

export type CsvColumn<T> = {
	header: string;
	accessor: (row: T) => CsvValue;
};

export type CsvOptions = {
	/** Include UTF-8 BOM (recommended for Excel). Default: true */
	bom?: boolean;
	/** Line ending. Default: "\n" */
	newline?: "\n" | "\r\n";
	/** Column delimiter. Default: "," */
	delimiter?: string;
};

const DEFAULTS: Required<CsvOptions> = {
	bom: true,
	newline: "\n",
	delimiter: ","
};

function normalizeOptions(opts?: CsvOptions): Required<CsvOptions> {
	return {
		bom: opts?.bom ?? DEFAULTS.bom,
		newline: opts?.newline ?? DEFAULTS.newline,
		delimiter: opts?.delimiter ?? DEFAULTS.delimiter
	};
}

function stringifyValue(v: CsvValue): string {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") {
		// Preserve integers/decimals as-is; NaN/Infinity are blank.
		if (!Number.isFinite(v)) return "";
		return String(v);
	}
	return String(v);
}

function escapeCell(raw: string, delimiter: string): string {
	// RFC4180-ish:
	// - quote if contains delimiter, quote, CR or LF
	// - double quotes inside quoted cells
	const needsQuotes =
		raw.includes(delimiter) || raw.includes("\"") || raw.includes("\n") || raw.includes("\r");

	if (!needsQuotes) return raw;
	const doubled = raw.replace(/\"/g, "\"\"");
	return `"${doubled}"`;
}

/**
 * Convert an array of rows to CSV text.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], opts?: CsvOptions): string {
	const o = normalizeOptions(opts);
	const header = columns.map(c => escapeCell(c.header, o.delimiter)).join(o.delimiter);

	const lines: string[] = [header];

	for (const row of rows) {
		const line = columns
			.map(col => {
				const v = stringifyValue(col.accessor(row));
				return escapeCell(v, o.delimiter);
			})
			.join(o.delimiter);
		lines.push(line);
	}

	const csv = lines.join(o.newline) + o.newline;
	return o.bom ? `\uFEFF${csv}` : csv;
}

/**
 * Convenience helper for endpoints: produce an HttpResponseInit for CSV content.
 */
export function csvResponse(body: string, filename = "data.csv"): HttpResponseInit {
	return {
		status: 200,
		headers: {
			"content-type": "text/csv; charset=utf-8",
			// Nice-to-have: allow downloading as a file in browsers.
			"content-disposition": `attachment; filename=\"${filename}\"`
		},
		body
	};
}

/**
 * Flatten a "meta + items" response into CSV.
 *
 * Pattern we use in this repo:
 * {
 *   meta: { ... },
 *   items: [...]
 * }
 *
 * This helper prepends meta-fields as commented lines ("# key: value")
 * and then outputs the items table.
 */
export function toCsvWithMeta<T>(
	meta: Record<string, CsvValue>,
	items: readonly T[],
	columns: readonly CsvColumn<T>[],
	opts?: CsvOptions
): string {
	const o = normalizeOptions(opts);

	const metaLines = Object.entries(meta).map(([k, v]) => {
		const val = stringifyValue(v);
		// Keep as comment lines to avoid breaking the CSV structure.
		return `# ${k}: ${val}`;
	});

	const table = toCsv(items, columns, { ...o, bom: false });
	const full = [...metaLines, "", table.trimEnd()].join(o.newline) + o.newline;
	return o.bom ? `\uFEFF${full}` : full;
}

/**
 * Utility to build a stable filename like: measurements_test-1_pi-cpu-temp_2026-01-01T00-00-00Z_2026-01-02T00-00-00Z.csv
 */
export function makeCsvFilename(parts: readonly string[], ext = "csv"): string {
	const safe = (s: string) =>
		s
			.trim()
			.replace(/\s+/g, "_")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.slice(0, 128);

	const name = parts.map(p => safe(p)).filter(Boolean).join("_");
	return name.length ? `${name}.${ext}` : `data.${ext}`;
}