// api.js
(() => {
    "use strict";

    function getApiKey() {
        try {
            return window.localStorage.getItem("API_KEY") || "";
        } catch {
            return "";
        }
    }

    // Use localStorage cache for devices/sensors, but let app.js handle refresh updates.
    window.ApiCache = window.ApiCache || {};
    window.ApiCache.autoReloadOnChange = false;

    function __apiFindSelect(id) {
        try {
            return document.getElementById(id) || document.querySelector(id);
        } catch {
            return null;
        }
    }

    function __apiGetSelectValue(sel) {
        if (!sel) return "";
        return String(sel.value ?? "");
    }

    function __apiSetSelectOptions(sel, items, getValue, getLabel, keepValue) {
        if (!sel) return;
        const prev = keepValue !== undefined ? String(keepValue) : __apiGetSelectValue(sel);
        // Clear
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        for (const it of items) {
            const opt = document.createElement("option");
            opt.value = String(getValue(it));
            opt.textContent = String(getLabel(it));
            sel.appendChild(opt);
        }
        // Restore selection if possible
        if (prev) {
            const match = Array.from(sel.options).find(o => o.value === prev);
            if (match) sel.value = prev;
        }
    }

    function __apiTryRefreshFromCache(detail) {
        // If app.js has its own refresh/render functions, call them if present.
        // Otherwise, we do a safe minimal DOM update.
        try {
            if (typeof window.refreshUi === "function") {
                window.refreshUi(detail);
                return true;
            }
            if (typeof window.render === "function") {
                window.render(detail);
                return true;
            }
        } catch {
            // ignore
        }
        return false;
    }

    // Handle background cache refresh events from api.js without reloading the page.
    window.addEventListener("api:devicesUpdated", (ev) => {
        const detail = ev && ev.detail ? ev.detail : {};
        const devices = Array.isArray(detail.devices) ? detail.devices : [];
        if (__apiTryRefreshFromCache(detail)) return;

        // Best-effort update: keep current selection when possible.
        const deviceSel = __apiFindSelect("deviceSelect") || __apiFindSelect("#deviceSelect") || __apiFindSelect("#device") || __apiFindSelect("device");
        const sensorSel = __apiFindSelect("sensorSelect") || __apiFindSelect("#sensorSelect") || __apiFindSelect("#sensor") || __apiFindSelect("sensor");
        const prevDevice = __apiGetSelectValue(deviceSel);

        __apiSetSelectOptions(
            deviceSel,
            devices,
            d => d.deviceId,
            d => d.deviceId,
            prevDevice
        );

        // If the previously selected device no longer exists, fall back to first and refresh sensors.
        const currentDevice = __apiGetSelectValue(deviceSel);
        if (deviceSel && prevDevice && currentDevice !== prevDevice) {
            // selection changed because old one vanished
            // best-effort: clear sensors (app likely repopulates on device change)
            if (sensorSel) {
                while (sensorSel.firstChild) sensorSel.removeChild(sensorSel.firstChild);
            }
        }
    });

    window.addEventListener("api:sensorsUpdated", (ev) => {
        const detail = ev && ev.detail ? ev.detail : {};
        const deviceId = detail.deviceId ? String(detail.deviceId) : "";
        const sensors = Array.isArray(detail.sensors) ? detail.sensors : [];
        if (__apiTryRefreshFromCache(detail)) return;

        const deviceSel = __apiFindSelect("deviceSelect") || __apiFindSelect("#deviceSelect") || __apiFindSelect("#device") || __apiFindSelect("device");
        const sensorSel = __apiFindSelect("sensorSelect") || __apiFindSelect("#sensorSelect") || __apiFindSelect("#sensor") || __apiFindSelect("sensor");

        // Only update sensors if they belong to the currently selected device.
        const currentDevice = __apiGetSelectValue(deviceSel);
        if (deviceId && currentDevice && deviceId !== currentDevice) return;

        const prevSensor = __apiGetSelectValue(sensorSel);
        __apiSetSelectOptions(
            sensorSel,
            sensors,
            s => s.sensorId,
            s => s.sensorId,
            prevSensor
        );
    });

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
        const apiKey = getApiKey();
        const headers = {
            ...(opts && opts.headers ? opts.headers : {}),
            ...(apiKey ? { "x-api-key": apiKey } : {})
        };

        const res = await fetch(url, {
            credentials: "same-origin",
            headers,
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
        const apiKey = getApiKey();
        const headers = {
            ...(opts && opts.headers ? opts.headers : {}),
            ...(apiKey ? { "x-api-key": apiKey } : {})
        };

        const res = await fetch(url, {
            credentials: "same-origin",
            headers,
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

    // ------------------------------------------------------------
    // IndexedDB cache for measurements
    //
    // Goals:
    // - Cache telemetry measurements by (deviceId, sensorId, ts, seq)
    // - Track which time ranges have been fully cached per device+sensor
    // - When requesting a range, fetch only missing gaps from the API
    // - Measurements are treated as immutable once written
    // ------------------------------------------------------------

    const IDB_DB_NAME = "savoniaiot-cache";
    const IDB_DB_VERSION = 1;

    function hasIndexedDb() {
        try {
            return typeof window !== "undefined" && "indexedDB" in window && window.indexedDB;
        } catch {
            return false;
        }
    }

    function idbOpen() {
        return new Promise((resolve, reject) => {
            if (!hasIndexedDb()) {
                reject(new Error("IndexedDB not available"));
                return;
            }

            const req = window.indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);

            req.onupgradeneeded = () => {
                const db = req.result;

                // Store measurements as individual rows keyed by device|sensor|ts|seq
                if (!db.objectStoreNames.contains("measurements")) {
                    const store = db.createObjectStore("measurements", { keyPath: "id" });
                    // Query by deviceId+sensorId+ts+seq for range scans.
                    store.createIndex("byDeviceSensorTsSeq", ["deviceId", "sensorId", "ts", "seq"], { unique: false });
                }

                // Track cached time intervals per device+sensor
                if (!db.objectStoreNames.contains("measurementIntervals")) {
                    db.createObjectStore("measurementIntervals", { keyPath: "key" });
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
        });
    }

    function idbReqToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
        });
    }

    function idbTxDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
            tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction error"));
        });
    }

    function intervalKey(deviceId, sensorId) {
        return `${String(deviceId)}|${String(sensorId)}`;
    }

    function normalizeIso(s) {
        // Assume caller provides ISO Z strings; keep as-is.
        return String(s);
    }

    function mergeIntervals(intervals) {
        // intervals: Array<{from:string,to:string}>
        if (!Array.isArray(intervals) || intervals.length === 0) return [];
        const sorted = [...intervals]
            .filter(i => i && typeof i.from === "string" && typeof i.to === "string")
            .map(i => ({ from: normalizeIso(i.from), to: normalizeIso(i.to) }))
            .sort((a, b) => a.from.localeCompare(b.from));

        const out = [];
        for (const cur of sorted) {
            if (out.length === 0) {
                out.push(cur);
                continue;
            }
            const last = out[out.length - 1];
            // Overlap or touch -> merge
            if (cur.from <= last.to) {
                if (cur.to > last.to) last.to = cur.to;
            } else {
                out.push(cur);
            }
        }
        return out;
    }

    function subtractIntervals(target, covered) {
        // target: {from,to}, covered: merged array
        // returns gaps: Array<{from,to}>
        const gaps = [];
        const tFrom = normalizeIso(target.from);
        const tTo = normalizeIso(target.to);

        if (!covered || covered.length === 0) return [{ from: tFrom, to: tTo }];

        let cursor = tFrom;
        for (const c of covered) {
            const cFrom = c.from;
            const cTo = c.to;
            if (cTo < cursor) continue;
            if (cFrom > tTo) break;

            // Gap before this covered interval
            if (cFrom > cursor) {
                const gapTo = cFrom < tTo ? cFrom : tTo;
                if (cursor < gapTo) gaps.push({ from: cursor, to: gapTo });
            }

            // Advance cursor
            if (cTo > cursor) cursor = cTo;
            if (cursor >= tTo) break;
        }

        // Gap after last covered interval
        if (cursor < tTo) gaps.push({ from: cursor, to: tTo });

        return gaps;
    }

    async function idbReadIntervals(db, key) {
        const tx = db.transaction(["measurementIntervals"], "readonly");
        const store = tx.objectStore("measurementIntervals");
        const row = await idbReqToPromise(store.get(key));
        await idbTxDone(tx);
        if (!row || !row.intervals) return [];
        return Array.isArray(row.intervals) ? row.intervals : [];
    }

    async function idbWriteIntervals(db, key, intervals) {
        const tx = db.transaction(["measurementIntervals"], "readwrite");
        const store = tx.objectStore("measurementIntervals");
        store.put({ key, intervals });
        await idbTxDone(tx);
    }

    async function idbPutMeasurements(db, deviceId, sensorId, rows) {
        if (!rows || rows.length === 0) return;
        const tx = db.transaction(["measurements"], "readwrite");
        const store = tx.objectStore("measurements");

        for (const r of rows) {
            // r = [ts, seq, value]
            if (!Array.isArray(r) || r.length < 3) continue;
            const ts = String(r[0]);
            const seq = Number(r[1]);
            if (!Number.isFinite(seq)) continue;
            const id = `${String(deviceId)}|${String(sensorId)}|${ts}|${seq}`;
            store.put({
                id,
                deviceId: String(deviceId),
                sensorId: String(sensorId),
                ts,
                seq,
                value: r[2]
            });
        }

        await idbTxDone(tx);
    }

    async function idbQueryMeasurementsRange(db, deviceId, sensorId, fromIso, toIso) {
        const tx = db.transaction(["measurements"], "readonly");
        const store = tx.objectStore("measurements");
        const idx = store.index("byDeviceSensorTsSeq");

        const lower = [String(deviceId), String(sensorId), normalizeIso(fromIso), 0];
        const upper = [String(deviceId), String(sensorId), normalizeIso(toIso), Number.MAX_SAFE_INTEGER];
        const range = IDBKeyRange.bound(lower, upper);

        const out = [];

        await new Promise((resolve, reject) => {
            const req = idx.openCursor(range);
            req.onerror = () => reject(req.error || new Error("IndexedDB cursor failed"));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                const v = cursor.value;
                out.push([v.ts, v.seq, v.value]);
                cursor.continue();
            };
        });

        await idbTxDone(tx);
        return out;
    }

    async function fetchAndCacheRange(db, deviceId, sensorId, fromIso, toIso, limit) {
        // Fetch full range via existing pagination, then cache.
        const fetched = [];
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
                if (!Array.isArray(row) || row.length < 3) continue;
                fetched.push(row);
            }

            if (!page.hasMore || !page.nextCursor) break;
            afterTs = page.nextCursor.afterTs;
            afterSeq = page.nextCursor.afterSeq;

            if (!afterTs || afterSeq === undefined || afterSeq === null) break;
        }

        await idbPutMeasurements(db, deviceId, sensorId, fetched);
        return fetched;
    }

    async function getAllMeasurementsCached(deviceId, sensorId, { fromIso, toIso, limit = 5000 }) {
        const db = await idbOpen();
        const key = intervalKey(deviceId, sensorId);

        // Load cached coverage
        const intervalsRaw = await idbReadIntervals(db, key);
        const intervals = mergeIntervals(intervalsRaw);

        // Determine gaps
        const target = { from: normalizeIso(fromIso), to: normalizeIso(toIso) };
        const gaps = subtractIntervals(target, intervals);

        // Fetch missing gaps and cache
        if (gaps.length > 0) {
            for (const g of gaps) {
                await fetchAndCacheRange(db, deviceId, sensorId, g.from, g.to, limit);
            }

            // Update and persist merged intervals (treat gaps as now covered)
            const next = mergeIntervals([...intervals, ...gaps]);
            await idbWriteIntervals(db, key, next);
        }

        // Now read the full range from cache and return
        const rows = await idbQueryMeasurementsRange(db, deviceId, sensorId, fromIso, toIso);
        try { db.close(); } catch { /* ignore */ }
        return rows;
    }

    async function getAllMeasurements(deviceId, sensorId, { fromIso, toIso, limit = 5000 }) {
        // If IndexedDB is available, use it to avoid re-fetching immutable data.
        // Falls back to the original API paging if IDB is not available or fails.
        if (hasIndexedDb()) {
            try {
                return await getAllMeasurementsCached(deviceId, sensorId, { fromIso, toIso, limit });
            } catch {
                // Fall back to API below.
            }
        }

        // Fallback: original behavior (API paging)
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

    // ------------------------------------------------------------
    // LocalStorage caching for devices + sensors
    //
    // Goals:
    // - Return cached data immediately (fast UI).
    // - Refresh cache in the background.
    // - If the background refresh detects a change, update storage and
    //   notify the app (and optionally auto-reload the page).
    //
    // Events dispatched on window:
    // - "api:devicesUpdated"  detail: { devices }
    // - "api:sensorsUpdated"  detail: { deviceId, sensors }
    //
    // Opt-in knobs (set anywhere before calls):
    // - window.ApiCache = { autoReloadOnChange: true|false }
    // ------------------------------------------------------------

    const CACHE_PREFIX = "savoniaiot";
    const CACHE_VERSION = "v1";

    function getCacheOptions() {
        // Default: auto-reload on change (matches requested behavior).
        const o = (window.ApiCache && typeof window.ApiCache === "object") ? window.ApiCache : {};
        return {
            autoReloadOnChange: o.autoReloadOnChange !== undefined ? Boolean(o.autoReloadOnChange) : true,
            // Optional: if you later want to stop auto reload for specific situations.
        };
    }

    function lsGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function lsSet(key, value) {
        try {
            window.localStorage.setItem(key, value);
            return true;
        } catch {
            return false;
        }
    }

    function cacheKeyDevices() {
        return `${CACHE_PREFIX}:devices:${CACHE_VERSION}`;
    }

    function cacheKeySensors(deviceId) {
        return `${CACHE_PREFIX}:sensors:${CACHE_VERSION}:${String(deviceId)}`;
    }

    function normalizeDevices(devices) {
        if (!Array.isArray(devices)) return [];
        // Stable order for comparisons.
        return [...devices]
            .filter(d => d && typeof d === "object")
            .sort((a, b) => String(a.deviceId ?? "").localeCompare(String(b.deviceId ?? "")));
    }

    function normalizeSensors(sensors) {
        if (!Array.isArray(sensors)) return [];
        // Stable order for comparisons.
        return [...sensors]
            .filter(s => s && typeof s === "object")
            .sort((a, b) => String(a.sensorId ?? "").localeCompare(String(b.sensorId ?? "")));
    }

    function safeJsonParse(s) {
        try {
            return JSON.parse(s);
        } catch {
            return null;
        }
    }

    function cacheRead(key) {
        const raw = lsGet(key);
        if (!raw) return null;
        const obj = safeJsonParse(raw);
        if (!obj || typeof obj !== "object") return null;
        // Expected: { ts: number, data: any }
        if (!("data" in obj)) return null;
        return obj;
    }

    function cacheWrite(key, data) {
        const payload = {
            ts: Date.now(),
            data
        };
        lsSet(key, JSON.stringify(payload));
    }

    function stableStringify(v) {
        // Deterministic-ish stringify for our normalized arrays.
        // (Good enough for devices/sensors payloads.)
        try {
            return JSON.stringify(v);
        } catch {
            return "";
        }
    }

    function dispatch(name, detail) {
        try {
            window.dispatchEvent(new CustomEvent(name, { detail }));
        } catch {
            // ignore
        }
    }

    function maybeAutoReload() {
        const { autoReloadOnChange } = getCacheOptions();
        if (!autoReloadOnChange) return;
        // Defer so storage/event is committed before reload.
        setTimeout(() => {
            try {
                window.location.reload();
            } catch {
                // ignore
            }
        }, 0);
    }

    function refreshDevicesInBackground() {
        // Fire-and-forget background refresh.
        (async () => {
            const data = await fetchJson(buildUrl("/api/devices"));
            const fresh = normalizeDevices(data.devices ?? []);

            const key = cacheKeyDevices();
            const cached = cacheRead(key);
            const cachedNorm = normalizeDevices(cached?.data ?? []);

            const freshSig = stableStringify(fresh);
            const cachedSig = stableStringify(cachedNorm);

            if (freshSig && freshSig !== cachedSig) {
                cacheWrite(key, fresh);
                dispatch("api:devicesUpdated", { devices: fresh });
                maybeAutoReload();
            }
        })().catch(() => {
            // Background refresh failures should not break the UI.
        });
    }

    function refreshSensorsInBackground(deviceId) {
        (async () => {
            const data = await fetchJson(buildUrl(`/api/devices/${encodeURIComponent(deviceId)}/sensors`));
            const fresh = normalizeSensors(data.sensors ?? []);

            const key = cacheKeySensors(deviceId);
            const cached = cacheRead(key);
            const cachedNorm = normalizeSensors(cached?.data ?? []);

            const freshSig = stableStringify(fresh);
            const cachedSig = stableStringify(cachedNorm);

            if (freshSig && freshSig !== cachedSig) {
                cacheWrite(key, fresh);
                dispatch("api:sensorsUpdated", { deviceId, sensors: fresh });
                maybeAutoReload();
            }
        })().catch(() => {
            // ignore
        });
    }

    async function getDevices() {
        const key = cacheKeyDevices();
        const cached = cacheRead(key);

        if (cached && Array.isArray(cached.data)) {
            // Return cached immediately.
            refreshDevicesInBackground();
            return cached.data;
        }

        // No cache -> fetch normally, then populate cache.
        const data = await fetchJson(buildUrl("/api/devices"));
        const devices = normalizeDevices(data.devices ?? []);
        cacheWrite(key, devices);
        return devices;
    }

    async function getSensors(deviceId) {
        const key = cacheKeySensors(deviceId);
        const cached = cacheRead(key);

        if (cached && Array.isArray(cached.data)) {
            refreshSensorsInBackground(deviceId);
            return cached.data;
        }

        const data = await fetchJson(buildUrl(`/api/devices/${encodeURIComponent(deviceId)}/sensors`));
        const sensors = normalizeSensors(data.sensors ?? []);
        cacheWrite(key, sensors);
        return sensors;
    }

    function normalizeTriggerResponse(resp) {
        // Normalize backend envelopes to: { min?: number, max?: number } | null
        // Backend may return:
        // - { alertTrigger: {...} } or { alertTrigger: null }
        // - { trigger: {...} } or { trigger: null }
        // - trigger object itself
        if (!resp) return null;

        if (typeof resp === "object") {
            if (Object.prototype.hasOwnProperty.call(resp, "alertTrigger")) {
                const t = resp.alertTrigger;
                return t && typeof t === "object" ? t : null;
            }
            if (Object.prototype.hasOwnProperty.call(resp, "trigger")) {
                const t = resp.trigger;
                return t && typeof t === "object" ? t : null;
            }
        }

        // If an endpoint ever returns the trigger object directly.
        return resp && typeof resp === "object" ? resp : null;
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
            `/api/devices/${encodeURIComponent(deviceId)}/sensors/${encodeURIComponent(sensorId)}/trigger`
        );
        // If the endpoint returns JSON, return it; otherwise return true.
        const resp = await fetchJson(url, { method: "DELETE" });
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