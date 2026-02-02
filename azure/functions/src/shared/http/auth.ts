import type {HttpRequest, HttpResponseInit, InvocationContext} from "@azure/functions";
import type {Logger} from "../log";
import {createLogger} from "../log";

import {loadConfig} from "../config";
import {getString} from "./query";

export type ClientPrincipal = {
	identityProvider?: string;
	userId?: string;
	userDetails?: string;
	userRoles?: string[];
};

function getAllowedUsersFromConfig(): string[] {
	try {
		return loadConfig().httpAuth.allowedUsers ?? [];
	} catch {
		return [];
	}
}

function getExpectedApiKey(log?: ReturnType<typeof createLogger>): string | undefined {
	try {
		return loadConfig().httpAuth.apiKey;
	} catch (err) {
		log?.error("HTTP_API_KEY is not configured", err);
		return undefined;
	}
}

function json(status: number, body: Record<string, unknown> | string): HttpResponseInit {
	return typeof body === "string"
		? { status, body }
		: { status, jsonBody: body };
}

function getLogger(context?: InvocationContext): Logger {
	if (context) return createLogger(context);

	// Fallback for call sites that don't pass context. In Azure Functions,
	// console.* is captured into logs; locally it prints to stdout.
	const logLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
	const shouldLog = (level: "debug" | "info" | "error"): boolean => {
		if (level === "error") return true;
		if (logLevel === "debug") return true;
		return logLevel === "info" && level === "info";
	};

	return {
		info(message: string, ...args: unknown[]): void {
			if (shouldLog("info")) console.log(message, ...args);
		},
		debug(message: string, ...args: unknown[]): void {
			if (shouldLog("debug")) console.log(message, ...args);
		},
		error(message: string, ...args: unknown[]): void {
			console.error(message, ...args);
		}
	};
}

/**
 * Extract Static Web Apps client principal.
 *
 * In production, SWA forwards identity via `x-ms-client-principal` (base64-encoded JSON).
 * Locally / in some hosts, it may be available as `request.clientPrincipal`.
 */
// Removed getClientPrincipal function and all related usage

/**
 * Validate the API key from request headers.
 *
 * Expected header:
 *   x-api-key: <secret>
 *
 * If no API key is provided:
 * - Reject with 401.
 */
export async function verifyApiKey(
	request: HttpRequest,
	context?: InvocationContext
): Promise<{ ok: true } | { ok: false; response: HttpResponseInit }> {
	const log = getLogger(context);

	// Accept API key from header OR query string.
	// Supported query parameter names:
	// - x-api-key (explicit)
	// - code (Azure Functions-style)
	const providedKey = request.headers.get("x-api-key")
		?? getString(request, "x-api-key")
		?? getString(request, "code");

	log.info("auth: start", {
		hasApiKey: Boolean(providedKey)
	});

	if (providedKey) {
		log.info("auth: api key provided");
		const expectedKey = getExpectedApiKey(log);
		if (!expectedKey) {
			return {
				ok: false,
				response: json(500, "Server authentication not configured")
			};
		}

		if (providedKey !== expectedKey) {
			log.info("auth: invalid api key");
			return {
				ok: false,
				response: json(403, "Invalid API key")
			};
		}
		log.info("auth: api key accepted");
		return { ok: true };
	}

	// No API key provided -> reject
	log.info("auth: missing api key");
	return {
		ok: false,
		response: json(401, "API key required")
	};
}