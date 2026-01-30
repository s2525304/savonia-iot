import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { loadConfig } from "../config";
import { createLogger } from "../log";

/**
 * Validate API key from request headers.
 *
 * Expected header:
 *   x-api-key: <secret>
 *
 */
export function verifyApiKey(
    request: HttpRequest,
    context?: InvocationContext
): { ok: true } | { ok: false; response: HttpResponseInit } {
    const log = context ? createLogger(context) : undefined;

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

    const providedKey =
        request.headers.get("x-api-key") ??
        request.headers.get("X-Api-Key");

    if (!providedKey) {
        return {
            ok: false,
            response: {
                status: 401,
                body: "Missing API key"
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