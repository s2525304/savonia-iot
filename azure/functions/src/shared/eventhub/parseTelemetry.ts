import type { InvocationContext } from "@azure/functions";

import {
	normalizeEventHubBatch,
	extractEventHubBody,
	parseJsonSafe
} from "./event";
import { TelemetrySchema, type TelemetryMessage } from "./telemetry";

export type TelemetryValidationIssue = {
	path: (string | number)[];
	message: string;
};

type ZodIssueLike = {
	path: readonly (string | number | symbol)[];
	message: string;
};

export type ParseTelemetryBadItem = {
	event: unknown;
	bodyPreview?: string;
	issues: TelemetryValidationIssue[];
};

export type ParseTelemetryResult = {
	ok: TelemetryMessage[];
	bad: ParseTelemetryBadItem[];
};

function previewBody(body: string, maxLen = 256): string {
	const trimmed = body.trim();
	if (trimmed.length <= maxLen) return trimmed;
	return trimmed.slice(0, maxLen) + "…";
}

function previewUnknown(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === "string") return previewBody(v);
	try {
		return previewBody(JSON.stringify(v));
	} catch {
		return undefined;
	}
}

function zodIssuesToValidationIssues(issues: readonly ZodIssueLike[]): TelemetryValidationIssue[] {
	return issues.map(i => ({
		path: i.path
			.map((p): string | number => (typeof p === "symbol" ? (p.description ?? p.toString()) : p))
			.filter((p): p is string | number => typeof p === "string" || typeof p === "number"),
		message: i.message
	}));
}

/**
 * Parse and validate an Event Hub batch into TelemetryMessage objects.
 *
 * - Uses `event.ts` to normalize Event Hub trigger "weirdness" and extract/parse the payload.
 * - Uses `telemetry.ts` (Zod) to validate and normalize the payload (schemaVersion, valueType/value, etc.).
 *
 * This function is intentionally tolerant: it returns both ok + bad items so ingestion can proceed.
 */
export function parseTelemetryBatch(
	events: unknown,
	context?: InvocationContext
): ParseTelemetryResult {
	const ok: TelemetryMessage[] = [];
	const bad: ParseTelemetryBadItem[] = [];

	const batch = normalizeEventHubBatch(events);

	for (const ev of batch) {
		const body = extractEventHubBody(ev);
		if (body === undefined) {
			bad.push({
				event: ev,
				issues: [{ path: [], message: "Missing event body" }]
			});
			continue;
		}

		const parsed = parseJsonSafe(body);
		if (parsed === undefined) {
			bad.push({
				event: ev,
				bodyPreview: previewUnknown(body),
				issues: [{ path: [], message: "Body is not valid JSON" }]
			});
			continue;
		}

		const res = TelemetrySchema.safeParse(parsed);
		if (res.success) {
			ok.push(res.data);
		} else {
			bad.push({
				event: ev,
				bodyPreview: previewUnknown(body),
				issues: zodIssuesToValidationIssues(res.error.issues)
			});
		}
	}

	// Optional lightweight debug logging without leaking full payloads
	if (context && bad.length > 0) {
		context.log?.(
			"parseTelemetryBatch: dropped invalid telemetry events",
			{ bad: bad.length, ok: ok.length }
		);
	}

	return { ok, bad };
}

/** Convenience helper for single-event triggers/tests. */
export function parseTelemetryOne(
	event: unknown,
	context?: InvocationContext
): { ok: true; value: TelemetryMessage } | { ok: false; issues: TelemetryValidationIssue[] } {
	const { ok, bad } = parseTelemetryBatch(event, context);
	if (ok.length === 1 && bad.length === 0) return { ok: true, value: ok[0] };
	if (bad.length > 0) return { ok: false, issues: bad[0].issues };
	return { ok: false, issues: [{ path: [], message: "No telemetry event" }] };
}
