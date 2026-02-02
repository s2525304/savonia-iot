import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import { loadConfig } from "../config";
import { createLogger } from "../log";

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

/**
 * Extract Static Web Apps client principal.
 *
 * In production, SWA forwards identity via `x-ms-client-principal` (base64-encoded JSON).
 * Locally / in some hosts, it may be available as `request.clientPrincipal`.
 */
function getClientPrincipal(request: HttpRequest): ClientPrincipal | undefined {
	const anyReq = request as unknown as { clientPrincipal?: ClientPrincipal };
	if (anyReq.clientPrincipal) return anyReq.clientPrincipal;

	// SWA -> Function App linked API forwards the principal in this header.
	const header = request.headers.get("x-ms-client-principal");
	if (!header) return undefined;

	try {
		const jsonStr = Buffer.from(header, "base64").toString("utf8");
		const parsed = JSON.parse(jsonStr) as ClientPrincipal;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Validate the API key from request headers OR allow authenticated Static Web Apps user.
 *
 * Expected header:
 *   x-api-key: <secret>
 *
 * If no API key is provided:
 * - Require an authenticated SWA principal.
 * - If `httpAuth.allowedUsers` is set (non-empty), require userId OR userDetails to be listed.
 * - If `httpAuth.allowedUsers` is not set / empty, allow any authenticated user.
 */
export function verifyApiKey(
	request: HttpRequest,
	context?: InvocationContext
): { ok: true } | { ok: false; response: HttpResponseInit } {
	const log = context ? createLogger(context) : undefined;
	log?.info("auth: start", {
		hasApiKey: request.headers.has("x-api-key"),
		hasClientPrincipalHeader: request.headers.has("x-ms-client-principal")
	});

	// Headers in Azure Functions are effectively case-insensitive; `.get()` handles that.
	const providedKey = request.headers.get("x-api-key");
	if (providedKey) {
		log?.info("auth: api key provided");
		const expectedKey = getExpectedApiKey(log);
		if (!expectedKey) {
			return {
				ok: false,
				response: json(500, "Server authentication not configured")
			};
		}

		if (providedKey !== expectedKey) {
			log?.info("auth: invalid api key");
			return {
				ok: false,
				response: json(403, "Invalid API key")
			};
		}
		log?.info("auth: api key accepted");
		return { ok: true };
	}

	// No API key provided -> attempt Static Web Apps authentication
	const clientPrincipal = getClientPrincipal(request);
	if (!clientPrincipal) {
		log?.info("auth: no client principal found");
		return {
			ok: false,
			response: json(401, "Unauthenticated")
		};
	}

	// Treat missing/empty allowedUsers as: allow any authenticated user.
	const roles = Array.isArray(clientPrincipal.userRoles) ? clientPrincipal.userRoles : [];
	const isAuthenticated = roles.includes("authenticated");
	log?.info("auth: client principal", {
		identityProvider: clientPrincipal.identityProvider,
		userId: clientPrincipal.userId,
		userDetails: clientPrincipal.userDetails,
		roles: clientPrincipal.userRoles
	});
	if (!isAuthenticated) {
		return {
			ok: false,
			response: json(401, "Unauthenticated")
		};
	}

	const allowedUsers = getAllowedUsersFromConfig();
	if (allowedUsers.length === 0) {
		log?.info("auth: allowedUsers empty -> allowing any authenticated user");
		return { ok: true };
	}

	const userId = (clientPrincipal.userId ?? "").trim();
	const userDetails = (clientPrincipal.userDetails ?? "").trim();
	if (!allowedUsers.includes(userId) && !allowedUsers.includes(userDetails)) {
		log?.info("auth: user not in allowedUsers", { userId, userDetails, allowedUsers });
		return {
			ok: false,
			response: json(403, { error: "User not allowed", userId, userDetails })
		};
	}
	log?.info("auth: authenticated user allowed");
	return { ok: true };
}