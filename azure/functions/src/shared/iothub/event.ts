

// src/shared/iothub/event.ts
//
// Azure Event Hub trigger payloads can arrive in multiple shapes depending on runtime/SDK:
// - string
// - Buffer / Uint8Array
// - already-parsed object
// - wrapper object like { body: ... }
//
// This module normalizes those shapes so downstream code can focus on telemetry parsing.

export type EventHubIncoming = unknown;

export function normalizeEventHubBatch(event: EventHubIncoming): unknown[] {
	if (Array.isArray(event)) {
		return event;
	}
	return [event];
}

export function extractEventHubBody(event: EventHubIncoming): unknown {
	if (event == null) {
		return undefined;
	}

	// 1) Plain string
	if (typeof event === "string") {
		return event;
	}

	// 2) Node Buffer
	if (Buffer.isBuffer(event)) {
		return event.toString("utf8");
	}

	// 3) Uint8Array (some hosts/libraries)
	if (event instanceof Uint8Array) {
		return Buffer.from(event).toString("utf8");
	}

	// 4) Object (may be parsed JSON already, or wrapper with `body`)
	if (typeof event === "object") {
		const maybeWrapper = event as { body?: unknown };
		if (Object.prototype.hasOwnProperty.call(maybeWrapper, "body")) {
			return maybeWrapper.body;
		}
		return event;
	}

	return undefined;
}

export function parseJsonSafe(input: unknown): unknown {
	if (input == null) {
		return undefined;
	}

	// If it is a string, attempt JSON parse.
	if (typeof input === "string") {
		try {
			return JSON.parse(input);
		} catch {
			return undefined;
		}
	}

	// Otherwise it might already be an object.
	return input;
}

export function getEventHubJsonBatch(event: EventHubIncoming): unknown[] {
	const batch = normalizeEventHubBatch(event);
	const out: unknown[] = [];

	for (const item of batch) {
		const body = extractEventHubBody(item);
		const parsed = parseJsonSafe(body);
		if (parsed !== undefined) {
			out.push(parsed);
		}
	}

	return out;
}