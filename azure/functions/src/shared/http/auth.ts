import type {HttpRequest, HttpResponseInit, InvocationContext} from "@azure/functions";
import type {Logger} from "../log";
import {createLogger} from "../log";

import {loadConfig} from "../config";

import {createRemoteJWKSet, decodeJwt, jwtVerify, JWTVerifyResult} from "jose";

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
 * Verify SWA JWT token from x-ms-auth-token header.
 * Verifies signature, issuer and audience.
 */
async function verifySwaJwt(token: string, log: Logger): Promise<JWTVerifyResult | undefined> {
	try {
		const config = loadConfig();
		const issuer = config.httpAuth.jwtIssuer;
		const audience = config.httpAuth.jwtAudience;
		const jwksUri = config.httpAuth.jwksUri;

		log.info("auth: jwt config", { issuer, audience, jwksUri });

		if (!issuer || !audience || !jwksUri) {
			log.error("JWT verification configuration missing", { issuer, audience, jwksUri });
			return undefined;
		}

		async function logJwksSummary(url: string): Promise<void> {
			try {
				// Node 18+ has global fetch in Azure Functions. If not, this will throw and we log that.
				const res = await fetch(url, { method: "GET" });
				const ct = res.headers.get("content-type") ?? undefined;
				const text = await res.text();

				if (!res.ok) {
					log.error("auth: jwks fetch failed", {
						url,
						status: res.status,
						contentType: ct,
						bodyPreview: text.slice(0, 300)
					});
					return;
				}

				let parsed: any;
				try {
					parsed = JSON.parse(text);
				} catch {
					log.error("auth: jwks is not valid JSON", {
						url,
						status: res.status,
						contentType: ct,
						bodyPreview: text.slice(0, 300)
					});
					return;
				}

				const keys: any[] = Array.isArray(parsed?.keys) ? parsed.keys : [];
				const kids = keys
					.map(k => (typeof k?.kid === "string" ? k.kid : undefined))
					.filter((k): k is string => typeof k === "string");

				log.info("auth: jwks summary", {
					url,
					status: res.status,
					contentType: ct,
					keys: keys.length,
					kids: kids.slice(0, 10)
				});
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				log.error("auth: jwks fetch threw", {
					name: err.name,
					message: err.message,
					stack: err.stack
				});
			}
		}

		await logJwksSummary(jwksUri);

		const JWKS = createRemoteJWKSet(new URL(jwksUri));
		return await jwtVerify(token, JWKS, {
			issuer,
			audience
		});
	} catch (e) {
		const err = e instanceof Error ? e : new Error(String(e));
		const anyErr = err as unknown as Record<string, unknown>;
		log.error("JWT verification failed", {
			name: err.name,
			message: err.message,
			code: anyErr["code"],
			stack: err.stack
		});
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
export async function verifyApiKey(
	request: HttpRequest,
	context?: InvocationContext
): Promise<{ ok: true } | { ok: false; response: HttpResponseInit }> {
	const log = getLogger(context);

	const authToken = request.headers.get("x-ms-auth-token");
	const rawAuthToken = authToken?.trim();
	const jwtToken = rawAuthToken?.toLowerCase().startsWith("bearer ")
		? rawAuthToken.slice("bearer ".length).trim()
		: rawAuthToken;

	if (jwtToken) {
		// WARNING: test environment logging only
		log.info("auth: raw jwt token", {
			length: jwtToken.length,
			prefix: jwtToken.slice(0, 40)
		});

		try {
			const claims = decodeJwt(jwtToken);
			log.info("auth: decoded jwt claims (unverified)", {
				iss: claims.iss,
				aud: claims.aud,
				sub: claims.sub,
				exp: claims.exp,
				nbf: claims.nbf,
				iat: claims.iat
			});
		} catch (e) {
			log.error("auth: failed to decode jwt (unverified)", e);
		}
	}

	log.info("auth: start", {
		hasApiKey: request.headers.has("x-api-key"),
		hasClientPrincipalHeader: request.headers.has("x-ms-client-principal"),
		hasAuthToken: Boolean(jwtToken)
	});

	if (jwtToken) {
		log.info("auth: x-ms-auth-token provided, verifying JWT");
		const verified = await verifySwaJwt(jwtToken, log);
		if (!verified) {
			return {
				ok: false,
				response: json(401, "Invalid or expired authentication token")
			};
		}
		log.info("auth: JWT token verified");

		const allowedUsers = getAllowedUsersFromConfig();
		// Extract claims for user identification
		const claims = verified.payload;
		const sub = typeof claims.sub === "string" ? claims.sub : "";
		const preferredUsername = typeof claims.preferred_username === "string" ? claims.preferred_username : "";
		const name = typeof claims.name === "string" ? claims.name : "";
		const userId = sub.trim();
		const userDetails = preferredUsername.trim() || name.trim();

		if (allowedUsers.length === 0) {
			log.info("auth: allowedUsers empty -> allowing any authenticated user");
			return { ok: true };
		}

		if (!allowedUsers.includes(userId) && !allowedUsers.includes(userDetails)) {
			log.info("auth: user not in allowedUsers", { userId, userDetails, allowedUsers });
			return {
				ok: false,
				response: json(403, { error: "User not allowed", userId, userDetails })
			};
		}
		log.info("auth: authenticated user allowed");
		return { ok: true };
	}

	// Headers in Azure Functions are effectively case-insensitive; `.get()` handles that.
	const providedKey = request.headers.get("x-api-key");
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

	// No API key or JWT provided -> attempt Static Web Apps authentication
	const clientPrincipal = getClientPrincipal(request);
	if (!clientPrincipal) {
		log.info("auth: no client principal found");
		return {
			ok: false,
			response: json(401, "Unauthenticated")
		};
	}

	// Treat missing/empty allowedUsers as: allow any authenticated user.
	const roles = Array.isArray(clientPrincipal.userRoles) ? clientPrincipal.userRoles : [];
	const isAuthenticated = roles.includes("authenticated");
	log.info("auth: client principal", {
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
		log.info("auth: allowedUsers empty -> allowing any authenticated user");
		return { ok: true };
	}

	const userId = (clientPrincipal.userId ?? "").trim();
	const userDetails = (clientPrincipal.userDetails ?? "").trim();
	if (!allowedUsers.includes(userId) && !allowedUsers.includes(userDetails)) {
		log.info("auth: user not in allowedUsers", { userId, userDetails, allowedUsers });
		return {
			ok: false,
			response: json(403, { error: "User not allowed", userId, userDetails })
		};
	}
	log.info("auth: authenticated user allowed");
	return { ok: true };
}