import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { loadConfig } from "../config";
import { createLogger } from "../log";

function getAllowedUsersFromConfig(): string[] {
    try {
        return loadConfig().httpAuth.allowedUsers ?? [];
    } catch {
        return [];
    }
}

/**
 * Validate API key from request headers or Static Web Apps authenticated user.
 *
 * Expected header:
 *   x-api-key: <secret>
 *
 * Or authenticated Static Web Apps user whose userId or userDetails is allowed.
 *
 */
export function verifyApiKey(
    request: HttpRequest,
    context?: InvocationContext
): { ok: true } | { ok: false; response: HttpResponseInit } {
    const log = context ? createLogger(context) : undefined;

    const providedKey =
        request.headers.get("x-api-key") ??
        request.headers.get("X-Api-Key");

    if (providedKey) {
        let expectedKey: string | undefined;
        try {
            expectedKey = loadConfig().httpAuth.apiKey;
        } catch (err) {
            log?.error("HTTP_API_KEY is not configured", err);
            return {
                ok: false,
                response: {
                    status: 500,
                    body: "Server authentication not configured"
                }
            };
        }

        if (providedKey !== expectedKey) {
            return {
                ok: false,
                response: {
                    status: 403,
                    body: "Invalid API key"
                }
            };
        }

        return { ok: true };
    }

    // No API key provided, attempt Static Web Apps authentication
    const clientPrincipal = (request as any).clientPrincipal;
    if (!clientPrincipal) {
        return {
            ok: false,
            response: {
                status: 401,
                body: "Unauthenticated"
            }
        };
    }

    const allowedUsers = getAllowedUsersFromConfig();
    if (allowedUsers.length === 0) {
        return {
            ok: false,
            response: {
                status: 403,
                body: "No users allowed"
            }
        };
    }

    const { userId, userDetails } = clientPrincipal;
    if (!allowedUsers.includes(userId) && !allowedUsers.includes(userDetails)) {
        return {
            ok: false,
            response: {
                status: 403,
                body: "User not allowed"
            }
        };
    }

    return { ok: true };
}