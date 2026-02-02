

export class QueueMessageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QueueMessageError";
	}
}

function parseJsonSafe(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Normalize Azure Storage Queue trigger payloads.
 *
 * Handles:
 * - plain JSON string (normal Azure runtime)
 * - already-parsed object (tests / local helpers)
 * - `{ messageText: string }` wrappers
 * - arrays (returns each item)
 */
export function normalizeQueueMessage(payload: unknown): unknown[] {
	if (payload == null) return [];

	// Azure Queue trigger normally gives a string
	if (typeof payload === "string") {
		const parsed = parseJsonSafe(payload);
		if (parsed === undefined) return [];
		return Array.isArray(parsed) ? parsed : [parsed];
	}

	// Some bindings wrap the message
	if (typeof payload === "object") {
		const anyP = payload as { messageText?: unknown };
		if (typeof anyP.messageText === "string") {
			const parsed = parseJsonSafe(anyP.messageText);
			if (parsed === undefined) return [];
			return Array.isArray(parsed) ? parsed : [parsed];
		}
	}

	// Already an object
	return Array.isArray(payload) ? payload : [payload];
}

/**
 * Parse a queue message and return a single item.
 * Throws if zero or more than one item is present.
 */
export function parseQueueMessage<T>(payload: unknown): T {
	const items = normalizeQueueMessage(payload);
	if (items.length === 0) {
		throw new QueueMessageError("Queue message is empty or unparsable");
	}
	if (items.length > 1) {
		throw new QueueMessageError("Queue message contains multiple items");
	}
	return items[0] as T;
}

/**
 * Parse a queue message that may contain multiple items.
 * Returns an empty array if nothing could be parsed.
 */
export function parseQueueMessages<T>(payload: unknown): T[] {
	return normalizeQueueMessage(payload) as T[];
}