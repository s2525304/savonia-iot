// src/shared/http/endpoint.ts
//
// Shared helpers for Azure Functions HTTP endpoints.
//
// Goals:
// - Remove repetitive boilerplate from endpoints (logger + auth + consistent errors)
// - Keep endpoint handlers focused on: parse params -> query -> shape response (json/csv)
// - Do not hide business logic or response shapes behind heavy abstractions

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import { createLogger, type Logger } from "../log";
import { verifyApiKey } from "./auth";
import { QueryError, wantsCsv } from "./query";

export type EndpointArgs = {
	req: HttpRequest;
	context: InvocationContext;
	log: Logger;
	asCsv: boolean;
};

export type EndpointHandler = (args: EndpointArgs) => Promise<HttpResponseInit>;

export type EndpointOptions = {
	/** Whether to enforce API key auth. Default: true */
	requireAuth?: boolean;
	/** Override the operation name used in logs. Default: handler name or "http" */
	name?: string;
};

export function json(status: number, body: Record<string, unknown>): HttpResponseInit {
	return {
		status,
		jsonBody: body
	};
}

export function badRequest(message: string): HttpResponseInit {
	return json(400, { error: message });
}

export function serverError(message = "Internal server error"): HttpResponseInit {
	return json(500, { error: message });
}

export function csvOk(body: string, contentType = "text/csv; charset=utf-8"): HttpResponseInit {
	return {
		status: 200,
		headers: { "content-type": contentType },
		body
	};
}

function describeError(err: unknown): { name: string; message: string; stack?: string; code?: unknown; detail?: unknown; hint?: unknown } {
	const e = err instanceof Error ? err : new Error(String(err));
	const anyE = e as unknown as Record<string, unknown>;
	const get = (k: string): unknown => (k in anyE ? anyE[k] : undefined);
	return {
		name: e.name,
		message: e.message,
		stack: e.stack,
		code: get("code"),
		detail: get("detail"),
		hint: get("hint")
	};
}

/**
 * Wrap an HTTP handler with standard concerns:
 * - logger
 * - API key auth (default on)
 * - consistent error -> response mapping
 */
export function httpEndpoint(handler: EndpointHandler, opts?: EndpointOptions) {
	const requireAuth = opts?.requireAuth ?? true;
	const name = opts?.name ?? handler.name ?? "http";

	return async (req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
		const log = createLogger(context);
		const asCsv = wantsCsv(req);

		try {
			if (requireAuth) {
				// verifyApiKey has slightly different call sites across the repo (with/without context).
				// Call it with both to keep behavior consistent.
				const auth = await verifyApiKey(req, context);
				if (!auth.ok) return auth.response;
			}

			return await handler({ req, context, log, asCsv });
		} catch (err) {
			// Query parsing / validation errors are user errors.
			if (err instanceof QueryError) {
				log.info(`${name}: bad request`, { message: err.message, status: err.status });
				return json(err.status, { error: err.message });
			}

			// Anything else is unexpected.
			const d = describeError(err);
			log.error(`${name}: unhandled error`, d);
			return serverError("Request failed");
		}
	};
}
