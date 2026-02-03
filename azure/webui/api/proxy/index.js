// azure/webui/api/[...path]/index.js
//
// Catch-all SWA API proxy:
// - Forwards the incoming request to:  {UPSTREAM_BASE_URL}/api/{path}?{query}
// - Preserves method, headers, and query params
// - Adds: x-api-key: {UPSTREAM_API_KEY} (also appends ?code= for Azure Functions-style keys)
//
// Env vars required:
// - UPSTREAM_BASE_URL   e.g. "https://savoniaiot-func-dev.azurewebsites.net"
// - UPSTREAM_API_CODE    e.g. "CHANGE_ME"

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length"
]);

// Some upstream responses (e.g., gzip) can cause SWA gateway/proxy 502 if we relay
// `content-encoding` while sending an already-decoded body. We drop these and set a
// correct content-length for the bytes we return.
const DROP_RESPONSE_HEADERS = new Set([
	...HOP_BY_HOP_HEADERS,
	"content-encoding",
	"set-cookie"
]);

function requireEnv(name) {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

function requireApiKey() {
	// Prefer the new name; fall back to the old name for backwards compatibility
	return process.env.UPSTREAM_API_KEY || requireEnv("UPSTREAM_API_CODE");
}

function toHeadersObject(headersLike) {
	// Azure Functions may provide headers as an object
	// Normalize to a plain object with lower-cased keys
	const out = {};
	if (!headersLike) return out;

	for (const [k, v] of Object.entries(headersLike)) {
		if (v === undefined || v === null) continue;
		out[String(k).toLowerCase()] = String(v);
	}
	return out;
}

function buildTargetUrl(req, pathParam) {
	const base = requireEnv("UPSTREAM_BASE_URL").replace(/\/+$/, "");

	// We want: /api/<path> + original query string
	// SWA gives [...path] as a single string (or undefined for /api)
	const pathPart = (pathParam ?? "").trim();
	const apiPath = pathPart ? `/api/${pathPart}` : "/api";

	// req.url typically includes "/api/..." already; but we rebuild from path + query safely
	// Extract query string from req.originalUrl or req.url if present
	const rawUrl = (req.originalUrl || req.url || "");
	const qIndex = rawUrl.indexOf("?");
	const queryString = qIndex >= 0 ? rawUrl.slice(qIndex) : "";

	const url = `${base}${apiPath}${queryString}`;

	// If caller didn't include an API key in query params, append Azure Functions-style `code`.
	// (Your upstream accepts header x-api-key OR query x-api-key OR query code.)
	const hasQuery = url.includes("?");
	const lower = url.toLowerCase();
	const hasKeyParam =
		lower.includes("?code=") || lower.includes("&code=") ||
		lower.includes("?x-api-key=") || lower.includes("&x-api-key=");

	if (!hasKeyParam) {
		const key = requireApiKey();
		const sep = hasQuery ? "&" : "?";
		return `${url}${sep}code=${encodeURIComponent(key)}`;
	}

	return url;
}

function getRequestBody(req) {
	// Azure Functions Node (v4) commonly provides:
	// - req.rawBody (string)
	// - req.body (object/string/buffer)
	if (req == null) return undefined;

	if (req.rawBody !== undefined && req.rawBody !== null && req.rawBody !== "") {
		return req.rawBody;
	}

	if (req.body === undefined || req.body === null) {
		return undefined;
	}

	// If it's already a string or Buffer, send as-is
	if (typeof req.body === "string") return req.body;
	if (Buffer.isBuffer(req.body)) return req.body;

	// Otherwise JSON encode
	try {
		return JSON.stringify(req.body);
	} catch {
		return String(req.body);
	}
}

function ensureContentType(headers, body) {
	// If we JSON-stringified an object, add content-type if missing.
	if (body === undefined) return;

	const hasCt = Object.prototype.hasOwnProperty.call(headers, "content-type");
	if (hasCt) return;

	// Heuristic: if body looks like JSON, default to application/json
	if (typeof body === "string") {
		const s = body.trim();
		if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
			headers["content-type"] = "application/json; charset=utf-8";
		}
	}
}

module.exports = async function (context, req) {
	try {
		const upstreamKey = requireApiKey();

		// SWA catch-all param name depends on your folder name: [...path]
		// It becomes bindingData.path
		const pathParam = context?.bindingData?.path ?? req?.params?.path;

		const targetUrl = buildTargetUrl(req, pathParam);

		// Copy inbound headers, remove hop-by-hop, then add our auth header
		const inbound = toHeadersObject(req.headers);

		const headers = {};
		for (const [k, v] of Object.entries(inbound)) {
			if (HOP_BY_HOP_HEADERS.has(k)) continue;
			headers[k] = v;
		}

		// Add/override required header
		headers["x-api-key"] = upstreamKey;
		// Ask upstream to send an uncompressed response to avoid content-encoding issues.
		headers["accept-encoding"] = "identity";

		const body = getRequestBody(req);
		ensureContentType(headers, body);

		const method = (req.method || "GET").toUpperCase();

		// Don’t send a body for GET/HEAD (some servers dislike it)
		const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";

		const res = await fetch(targetUrl, {
			method,
			headers,
			body: hasBody ? body : undefined
		});

		// Relay response safely (avoid gzip/content-encoding mismatch + hop-by-hop headers)
		const ab = await res.arrayBuffer();
		const buf = Buffer.from(ab);

		const resHeaders = {};
		res.headers.forEach((value, key) => {
			const k = String(key).toLowerCase();
			if (DROP_RESPONSE_HEADERS.has(k)) return;
			resHeaders[k] = value;
		});

		// Ensure content-length matches the bytes we return (and isn't stale)
		resHeaders["content-length"] = String(buf.length);

		context.res = {
			status: res.status,
			headers: resHeaders,
			body: buf
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		context.log(`[proxy] error: ${msg}`);
		context.res = {
			status: 500,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ error: "Proxy failed", detail: msg })
		};
	}
};