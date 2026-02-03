// api.js
(() => {
    "use strict";

    function buildUrl(path, params) {
        const url = new URL(path, window.location.origin);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                if (v === undefined || v === null || v === "") continue;
                url.searchParams.set(k, String(v));
            }
        }
        return url.toString();
    }

    async function fetchJson(url, opts) {
        const res = await fetch(url, {
            credentials: "same-origin",
            ...(opts ?? {})
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`API ${res.status}: ${text || res.statusText}`.trim());
        }

        // Some endpoints may return empty body on success.
        if (res.status === 204) return null;

        const ct = (res.headers.get("content-type") ?? "").toLowerCase();
        if (ct.includes("application/json")) return await res.json();

        // Fallback: return text.
        return await res.text();
    }

    async function fetchJsonOptional(url, opts) {
        const res = await fetch(url, {
            credentials: "same-origin",
            ...(opts ?? {})
        });

        if (res.status === 404) return null;

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`API ${res.status}: ${text || res.statusText}`.trim());
        }

        if (res.status === 204) return null;

        const ct = (res.headers.get("content-type") ?? "").toLowerCase();
        if (ct.includes("application/json")) return await res.json();
        return await res.text();
    }

    async function fetchMeasurementsPage(deviceId, sensorId, { fromIso, toIso, limit, afterTs, afterSeq }) {
        const url = buildUrl(
            `/api/devices/${encodeURIComponent(deviceId)}/sensors/${encodeURIComponent(sensorId)}/measurements`,
            { from: fromIso, to: toIso, limit, afterTs, afterSeq }
        );
        return await fetchJson(url);
    }

    async function getAllMeasurements(deviceId, sensorId, { fromIso, toIso, limit = 5000 }) {
        const items = [];
        let afterTs;
        let afterSeq;

        for (;;) {
            const page = await fetchMeasurementsPage(deviceId, sensorId, {
                fromIso,
                toIso,
                limit,
                afterTs,
                afterSeq
            });

            const pageItems = page.items ?? [];
            for (const row of pageItems) {
                // Expected: [ts, seq, value]
                if (!Array.isArray(row) || row.length < 3) continue;
                items.push(row);
            }

            if (!page.hasMore || !page.nextCursor) break;
            afterTs = page.nextCursor.afterTs;
            afterSeq = page.nextCursor.afterSeq;

            if (!afterTs || afterSeq === undefined || afterSeq === null) break;
        }

        return items;
    }

    async function fetchHourlyPage(deviceId, sensorId, { fromIso, toIso, limit, afterTs, afterSeq }) {
        const url = buildUrl(
            `/api/devices/${encodeURIComponent(deviceId)}/sensors/${encodeURIComponent(sensorId)}/hourly`,
            { from: fromIso, to: toIso, limit, afterTs, afterSeq }
        );
        return await fetchJson(url);
    }

    async function getAllHourly(deviceId, sensorId, { fromIso, toIso, limit = 1000 }) {
        const rows = [];
        let afterTs;
        let afterSeq;

        for (;;) {
            const page = await fetchHourlyPage(deviceId, sensorId, {
                fromIso,
                toIso,
                limit,
                afterTs,
                afterSeq
            });

            const items = page.items ?? [];
            for (const row of items) {
                // Expected: [hourTs, avg, min, max, count]
                if (!Array.isArray(row) || row.length < 5) continue;
                rows.push(row);
            }

            if (!page.hasMore || !page.nextCursor) break;
            afterTs = page.nextCursor.afterTs;
            afterSeq = page.nextCursor.afterSeq;

            if (!afterTs || afterSeq === undefined || afterSeq === null) break;
        }

        return rows;
    }

    async function getDevices() {
        const data = await fetchJson(buildUrl("/api/devices"));
        return data.devices ?? [];
    }

    async function getSensors(deviceId) {
        const data = await fetchJson(buildUrl(`/api/devices/${encodeURIComponent(deviceId)}/sensors`));
        return data.sensors ?? [];
    }

    function normalizeTriggerResponse(resp) {
        // Accept:
        // - { alertTrigger: {...} }
        // - { trigger: {...} }
        // - trigger object itself
        if (!resp) return null;
        if (typeof resp === "object") {
            if (resp.alertTrigger && typeof resp.alertTrigger === "object") return resp.alertTrigger;
            if (resp.trigger && typeof resp.trigger === "object") return resp.trigger;
        }
        return null;
    }


    async function getAlertTrigger(deviceId, sensorId) {
        const url = buildUrl(
            `/api/devices/${encodeURIComponent(deviceId)}/sensors/${encodeURIComponent(sensorId)}/trigger`
        );
        const resp = await fetchJsonOptional(url);
        return normalizeTriggerResponse(resp);
    }

    async function upsertAlertTrigger(deviceId, sensorId, { min, max }) {
        // Per your API contract: min/max are query params.
        // Only include params that are defined; omitting a bound removes it server-side.
        const url = buildUrl(
            `/api/devices/${encodeURIComponent(deviceId)}/sensors/${encodeURIComponent(sensorId)}/trigger`,
            {
                min: min === undefined || min === null || min === "" ? undefined : min,
                max: max === undefined || max === null || max === "" ? undefined : max
            }
        );
        const resp = await fetchJson(url);
        return normalizeTriggerResponse(resp);
    }

    async function deleteAlertTrigger(deviceId, sensorId) {
        const url = buildUrl(
            `/api/devices/${encodeURIComponent(deviceId)}/sensors/${encodeURIComponent(sensorId)}/trigger?min=&max=`
        );
        // If the endpoint returns JSON, return it; otherwise return true.
        const resp = await fetchJson(url, { method: "GET" });
        if (resp === null || resp === "" || resp === undefined) return true;
        return resp;
    }

    window.Api = {
        getDevices,
        getSensors,
        getAllMeasurements,
        getAllHourly,
        getAlertTrigger,
        upsertAlertTrigger,
        deleteAlertTrigger
    };
})();