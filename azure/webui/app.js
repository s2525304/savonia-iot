(async () => {
	if (!window.Auth || typeof window.Auth.requireWebui !== "function") {
		document.body.innerHTML = "<h2>Missing auth.js</h2>";
		return;
	}

	const principal = await window.Auth.requireWebui();
	if (!principal) {
		// Auth helper already updated UI (status/app visibility)
		return;
	}

	if (!window.Utils) {
		document.body.innerHTML = "<h2>Missing utils.js</h2>";
		return;
	}
	if (!window.Api) {
		document.body.innerHTML = "<h2>Missing api.js</h2>";
		return;
	}
	if (!window.Graph) {
		document.body.innerHTML = "<h2>Missing graph.js</h2>";
		return;
	}
	const {
		toDatetimeLocalValue,
		toIsoFromDatetimeLocal,
		parseDatetimeLocal,
		clampDate,
		formatFilenameSafe
	} = window.Utils;
	const {
		getDevices,
		getSensors,
		getAllMeasurements,
		getAllHourly,
		getAlertTrigger,
		upsertAlertTrigger,
		deleteAlertTrigger
	} = window.Api;

	const deviceSelect = document.getElementById("device-select");
	const sensorSelect = document.getElementById("sensor-select");

	const loadButton = document.getElementById("load");
	const csvButton = document.getElementById("csv");
	const chartCanvas = document.getElementById("chart");
	const legendRaw = document.getElementById("line-raw");
	const legendAvg = document.getElementById("line-avg");
	const legendMin = document.getElementById("line-min");
	const legendMax = document.getElementById("line-max");
	const legendBox = document.getElementById("legend");

	const triggerBox = document.getElementById("trigger");
	const triggerStatus = document.getElementById("trigger-status");
	const triggerMinInput = document.getElementById("trigger-min");
	const triggerMaxInput = document.getElementById("trigger-max");
	const triggerSaveButton = document.getElementById("trigger-save");
	const triggerClearButton = document.getElementById("trigger-clear");

	const alertsRefreshButton = document.getElementById("alerts-refresh");
	const alertsMeta = document.getElementById("alerts-meta");
	const alertsList = document.getElementById("alerts-list");

	// { min?: number, max?: number } | null
	let currentTrigger = null;

	/**
	 * @typedef {Object} LineGraph
	 * @property {(rawRows:any[], hourlyRows:any[], opts?:any)=>void} render
	 * @property {(cb:(tFrom:number, tTo:number)=>void|Promise<void>)=>void} onZoom
	 * @property {((trigger:any)=>void)=} setTrigger
	 */

	const { createLineGraph } = window.Graph;
	/** @type {LineGraph} */
	const graph = createLineGraph({
		canvas: chartCanvas,
		legends: {
			raw: legendRaw,
			avg: legendAvg,
			min: legendMin,
			max: legendMax
		},
		legendBox
	});

	const fromInput = document.getElementById("from");
	const toInput = document.getElementById("to");

	const zoomIn10m = document.getElementById("zoom-in-10m");
	const zoomOut10m = document.getElementById("zoom-out-10m");
	const zoomIn1h = document.getElementById("zoom-in-1h");
	const zoomOut1h = document.getElementById("zoom-out-1h");
	const zoomIn24h = document.getElementById("zoom-in-24h");
	const zoomOut24h = document.getElementById("zoom-out-24h");

	// sensorId -> sensor metadata (including firstTs/lastTs)
	const sensorMeta = new Map();

	const SESSION_KEY = "savonia-iot:webui:v1";

	let isRefreshingFromCacheEvent = false;

	function safeHasOption(selectEl, value) {
		if (!selectEl || !value) return false;
		return Array.from(selectEl.options ?? []).some(o => o && o.value === value);
	}

	function loadSessionState() {
		try {
			const raw = sessionStorage.getItem(SESSION_KEY);
			if (!raw) return null;
			const obj = JSON.parse(raw);
			return obj && typeof obj === "object" ? obj : null;
		} catch {
			return null;
		}
	}

	function saveSessionState(patch) {
		try {
			const prev = loadSessionState() ?? {};
			const next = { ...prev, ...patch };
			sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
		} catch {
			// ignore
		}
	}

	function getCurrentSelectionState() {
		return {
			deviceId: deviceSelect.value || null,
			sensorId: sensorSelect.value || null,
			from: fromInput.value || null,
			to: toInput.value || null,
		};
	}

	function setButtonsEnabled(enabled) {
		loadButton.disabled = !enabled;
		csvButton.disabled = !enabled;
	}

	async function fetchJson(url) {
		const res = await fetch(url, { credentials: "same-origin" });

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`API ${res.status}: ${text || res.statusText}`.trim());
		}

		if (res.status === 204) return null;

		const ct = (res.headers.get("content-type") ?? "").toLowerCase();
		if (ct.includes("application/json")) return await res.json();
		return await res.text();
	}

	function ensureFromToOrder() {
		const from = parseDatetimeLocal(fromInput.value);
		const to = parseDatetimeLocal(toInput.value);
		if (!from || !to) return;
		if (to < from) {
			// Keep the user's latest edit by snapping the other bound.
			toInput.value = fromInput.value;
		}
	}

	function getSensorBounds(sensorId) {
		const meta = sensorMeta.get(sensorId);
		if (!meta) return null;
		const min = new Date(meta.firstTs);
		const max = new Date(meta.lastTs);
		if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime())) return null;
		return { min, max };
	}

	function computeZoom(from, to, bounds, deltaMs, dir) {
		// dir: "out" expands window by deltaMs, "in" shrinks window by deltaMs.
		// Split adjustment equally, but if we hit an edge, give the remaining adjustment to the other side.
		const half = Math.floor(deltaMs / 2);
		let left = half;
		let right = deltaMs - half;

		let newFrom = new Date(from);
		let newTo = new Date(to);

		if (dir === "out") {
			newFrom = new Date(from.getTime() - left);
			newTo = new Date(to.getTime() + right);

			// Clamp to bounds; if we clamp one side, shift the remainder to the other side.
			if (newFrom < bounds.min) {
				const overshoot = bounds.min.getTime() - newFrom.getTime();
				newFrom = new Date(bounds.min);
				newTo = new Date(newTo.getTime() + overshoot);
			}
			if (newTo > bounds.max) {
				const overshoot = newTo.getTime() - bounds.max.getTime();
				newTo = new Date(bounds.max);
				newFrom = new Date(newFrom.getTime() - overshoot);
			}

			// Final clamp (in case shifting pushed the other side past bounds)
			if (newFrom < bounds.min) newFrom = new Date(bounds.min);
			if (newTo > bounds.max) newTo = new Date(bounds.max);
		} else {
			// Zoom in: shrink by moving ends inward
			newFrom = new Date(from.getTime() + left);
			newTo = new Date(to.getTime() - right);

			// If we'd invert, refuse (signals "can't zoom in anymore")
			if (newTo.getTime() <= newFrom.getTime()) {
				return { from, to, changed: false };
			}

			// Clamp to bounds (should rarely matter for zoom-in)
			if (newFrom < bounds.min) newFrom = new Date(bounds.min);
			if (newTo > bounds.max) newTo = new Date(bounds.max);

			if (newTo.getTime() <= newFrom.getTime()) {
				return { from, to, changed: false };
			}
		}

		const changed = newFrom.getTime() !== from.getTime() || newTo.getTime() !== to.getTime();
		return { from: newFrom, to: newTo, changed };
	}

	function setFromToDates(from, to) {
		fromInput.value = toDatetimeLocalValue(from);
		toInput.value = toDatetimeLocalValue(to);
		ensureFromToOrder();
		saveSessionState({ from: fromInput.value || null, to: toInput.value || null });
	}

	async function applyZoom(deltaMs, dir) {
		const sensorId = sensorSelect.value;
		if (!sensorId) return;
		const bounds = getSensorBounds(sensorId);
		if (!bounds) return;

		const curFrom = parseDatetimeLocal(fromInput.value);
		const curTo = parseDatetimeLocal(toInput.value);
		if (!curFrom || !curTo) return;

		const z = computeZoom(curFrom, curTo, bounds, deltaMs, dir);
		if (!z.changed) {
			updateZoomButtons();
			return;
		}

		setFromToDates(z.from, z.to);

		// Clamp once more to the sensor bounds (and enforce min/max attributes)
		applySensorTimeBounds(sensorId);

		updateZoomButtons();
		await loadAndRender();
	}

	function canZoom(deltaMs, dir) {
		const sensorId = sensorSelect.value;
		if (!sensorId) return false;
		const bounds = getSensorBounds(sensorId);
		if (!bounds) return false;

		const curFrom = parseDatetimeLocal(fromInput.value);
		const curTo = parseDatetimeLocal(toInput.value);
		if (!curFrom || !curTo) return false;

		const z = computeZoom(curFrom, curTo, bounds, deltaMs, dir);
		return Boolean(z.changed);
	}

	function updateZoomButtons() {
		const d10m = 10 * 60 * 1000;
		const d1h = 60 * 60 * 1000;
		const d24h = 24 * 60 * 60 * 1000;

		if (zoomIn10m) zoomIn10m.disabled = !canZoom(d10m, "in");
		if (zoomOut10m) zoomOut10m.disabled = !canZoom(d10m, "out");

		if (zoomIn1h) zoomIn1h.disabled = !canZoom(d1h, "in");
		if (zoomOut1h) zoomOut1h.disabled = !canZoom(d1h, "out");

		if (zoomIn24h) zoomIn24h.disabled = !canZoom(d24h, "in");
		if (zoomOut24h) zoomOut24h.disabled = !canZoom(d24h, "out");
	}

	function fmtLocal(tsIso) {
		try {
			const d = new Date(tsIso);
			if (Number.isNaN(d.getTime())) return String(tsIso);
			return d.toLocaleString();
		} catch {
			return String(tsIso);
		}
	}

	function computeAlertWindow(alertRow) {
		// Context window around the alert:
		// - from: start - 5 min
		// - to: end + 5 min (if closed), otherwise start + 30 min
		const start = new Date(alertRow.startTs);
		const end = alertRow.endTs ? new Date(alertRow.endTs) : null;

		const from = new Date(start.getTime() - 5 * 60 * 1000);
		let to;

		if (end && !Number.isNaN(end.getTime())) {
			to = new Date(end.getTime() + 5 * 60 * 1000);
		} else {
			to = new Date(start.getTime() + 30 * 60 * 1000);
		}

		return { from, to };
	}

	function clearAlertsUI(message) {
		if (alertsMeta) alertsMeta.textContent = message ?? "";
		if (alertsList) alertsList.innerHTML = "";
	}

	async function focusAlert(alertRow) {
		const deviceId = alertRow.deviceId;
		const sensorId = alertRow.sensorId;
		if (!deviceId || !sensorId) return;

		// Switch device if needed (loads sensors + metadata)
		if (deviceSelect.value !== deviceId) {
			deviceSelect.value = deviceId;
			await loadSensors(deviceId);
		}

		// Set the desired time window BEFORE clamping
		const { from, to } = computeAlertWindow(alertRow);
		fromInput.value = toDatetimeLocalValue(from);
		toInput.value = toDatetimeLocalValue(to);

		// Select sensor if available and clamp to sensor bounds
		if (sensorMeta.has(sensorId)) {
			sensorSelect.value = sensorId;
			applySensorTimeBounds(sensorId);

			fromInput.disabled = false;
			toInput.disabled = false;
			setButtonsEnabled(true);

			await loadTrigger(deviceId, sensorId);
			await loadAndRender();
			saveSessionState(getCurrentSelectionState());
		} else {
			alert(`Sensor '${sensorId}' not found for device '${deviceId}'`);
		}

		chartCanvas?.scrollIntoView?.({ behavior: "smooth", block: "start" });
	}

	function renderAlerts(items) {
		if (!alertsList) return;
		alertsList.innerHTML = "";

		for (const a of items) {
			const li = document.createElement("li");
			li.className = "alerts-item";
			li.tabIndex = 0;

			const main = document.createElement("div");
			main.className = "alerts-main";

			const title = document.createElement("div");
			title.className = "alerts-title";
			title.textContent = `${a.deviceId} / ${a.sensorId}`;

			const sub = document.createElement("div");
			sub.className = "alerts-sub";
			sub.textContent = a.endTs
				? `${fmtLocal(a.startTs)} → ${fmtLocal(a.endTs)}`
				: `${fmtLocal(a.startTs)} → (open)`;

			const reason = document.createElement("div");
			reason.className = "alerts-reason";
			reason.textContent = a.reason || "(no reason)";

			main.appendChild(title);
			main.appendChild(sub);
			main.appendChild(reason);

			const side = document.createElement("div");
			side.className = "alerts-side";

			const badge = document.createElement("span");
			badge.className = `alert-badge ${a.endTs ? "closed" : "open"}`;
			badge.textContent = a.endTs ? "Closed" : "Open";

			const updated = document.createElement("div");
			updated.className = "alert-time";
			updated.textContent = `Updated ${fmtLocal(a.updatedAt)}`;

			side.appendChild(badge);
			side.appendChild(updated);

			li.appendChild(main);
			li.appendChild(side);

			const onActivate = async () => {
				try {
					await focusAlert(a);
				} catch (err) {
					console.error(err);
					alert(err instanceof Error ? err.message : String(err));
				}
			};

			li.addEventListener("click", onActivate);
			li.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onActivate();
				}
			});

			alertsList.appendChild(li);
		}
	}

	async function loadAlertsLatest() {
		if (!alertsMeta || !alertsList) return;

		alertsMeta.textContent = "Loading…";
		if (alertsRefreshButton) alertsRefreshButton.disabled = true;

		try {
			const data = await fetchJson("/api/alert?limit=25");
			const items = data?.items ?? [];
			renderAlerts(items);
			alertsMeta.textContent = `Showing ${items.length} alerts • ${new Date().toLocaleTimeString()}`;
		} catch (err) {
			console.error("Failed to load alerts", err);
			clearAlertsUI("Failed to load alerts");
		} finally {
			if (alertsRefreshButton) alertsRefreshButton.disabled = false;
		}
	}

	graph.onZoom(async (tFrom, tTo) => {
		fromInput.value = toDatetimeLocalValue(new Date(tFrom));
		toInput.value = toDatetimeLocalValue(new Date(tTo));
		ensureFromToOrder();
		saveSessionState({ from: fromInput.value || null, to: toInput.value || null });
		await loadAndRender();
	});

	function applySensorTimeBounds(sensorId) {
		const meta = sensorMeta.get(sensorId);
		if (!meta) return;

		const min = new Date(meta.firstTs);
		const max = new Date(meta.lastTs);

		// Set hard limits
		fromInput.min = toDatetimeLocalValue(min);
		fromInput.max = toDatetimeLocalValue(max);
		toInput.min = toDatetimeLocalValue(min);
		toInput.max = toDatetimeLocalValue(max);

		// Preserve existing from/to if user already has selections; otherwise use defaults.
		const curFrom = parseDatetimeLocal(fromInput.value);
		const curTo = parseDatetimeLocal(toInput.value);

		if (curFrom && curTo) {
			const fromClamped = clampDate(curFrom, min, max);
			const toClamped = clampDate(curTo, min, max);
			fromInput.value = toDatetimeLocalValue(fromClamped);
			toInput.value = toDatetimeLocalValue(toClamped);
		} else {
			// Default: last 6 hours (clamped to min)
			const defaultTo = new Date(max);
			const defaultFrom = new Date(max);
			defaultFrom.setHours(defaultFrom.getHours() - 6);

			const fromClamped = clampDate(defaultFrom, min, max);
			const toClamped = clampDate(defaultTo, min, max);

			fromInput.value = toDatetimeLocalValue(fromClamped);
			toInput.value = toDatetimeLocalValue(toClamped);
		}

		ensureFromToOrder();
		updateZoomButtons();
	}

	function formatTriggerStatus(trigger) {
		if (!trigger) return "Not configured";
		const parts = [];
		if (trigger.min !== undefined && trigger.min !== null) parts.push(`min ${trigger.min}`);
		if (trigger.max !== undefined && trigger.max !== null) parts.push(`max ${trigger.max}`);
		return parts.length ? `Configured (${parts.join(", ")})` : "Configured";
	}

	function readNumberOrUndefined(inputEl) {
		const v = (inputEl.value ?? "").trim();
		if (!v) return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}

	function applyTriggerToGraph() {
		// Render-time overlay: graph.js should draw these if provided.
		const setTrigger = graph.setTrigger;
		if (typeof setTrigger === "function") {
			setTrigger(currentTrigger);
		}
	}

	async function loadTrigger(deviceId, sensorId) {
		if (!deviceId || !sensorId) {
			currentTrigger = null;
			triggerBox.hidden = true;
			return;
		}

		try {
			const trigger = await getAlertTrigger(deviceId, sensorId);
			currentTrigger = trigger ? {
				min: trigger.min,
				max: trigger.max
			} : null;

			triggerMinInput.value = currentTrigger?.min ?? "";
			triggerMaxInput.value = currentTrigger?.max ?? "";
			triggerStatus.textContent = formatTriggerStatus(currentTrigger);
			triggerBox.hidden = false;
			applyTriggerToGraph();
		} catch (err) {
			console.error("Failed to load trigger", err);
			currentTrigger = null;
			triggerMinInput.value = "";
			triggerMaxInput.value = "";
			triggerStatus.textContent = "Failed to load";
			triggerBox.hidden = false;
			applyTriggerToGraph();
		}
	}

	async function saveTrigger() {
		const deviceId = deviceSelect.value;
		const sensorId = sensorSelect.value;
		if (!deviceId || !sensorId) return;

		const min = readNumberOrUndefined(triggerMinInput);
		const max = readNumberOrUndefined(triggerMaxInput);

		setButtonsEnabled(false);
		triggerSaveButton.disabled = true;
		triggerClearButton.disabled = true;
		try {
			const trigger = await upsertAlertTrigger(deviceId, sensorId, { min, max });
			currentTrigger = trigger ? { min: trigger.min, max: trigger.max } : null;
			triggerStatus.textContent = formatTriggerStatus(currentTrigger);
			applyTriggerToGraph();
			await loadAndRender();
		} catch (err) {
			console.error(err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setButtonsEnabled(true);
			triggerSaveButton.disabled = false;
			triggerClearButton.disabled = false;
		}
	}

	async function clearTrigger() {
		const deviceId = deviceSelect.value;
		const sensorId = sensorSelect.value;
		if (!deviceId || !sensorId) return;

		setButtonsEnabled(false);
		triggerSaveButton.disabled = true;
		triggerClearButton.disabled = true;
		try {
			await deleteAlertTrigger(deviceId, sensorId);
			currentTrigger = null;
			triggerMinInput.value = "";
			triggerMaxInput.value = "";
			triggerStatus.textContent = formatTriggerStatus(currentTrigger);
			applyTriggerToGraph();
			await loadAndRender();
		} catch (err) {
			console.error(err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setButtonsEnabled(true);
			triggerSaveButton.disabled = false;
			triggerClearButton.disabled = false;
		}
	}

	async function loadAndRender() {
		const deviceId = deviceSelect.value;
		const sensorId = sensorSelect.value;
		const fromIso = toIsoFromDatetimeLocal(fromInput.value);
		const toIso = toIsoFromDatetimeLocal(toInput.value);

		if (!deviceId || !sensorId || !fromIso || !toIso) return;

		setButtonsEnabled(false);
		try {
			const [rawRows, hourlyRows] = await Promise.all([
				getAllMeasurements(deviceId, sensorId, {
					fromIso,
					toIso,
					limit: 5000
				}),
				getAllHourly(deviceId, sensorId, {
					fromIso,
					toIso,
					limit: 1000
				})
			]);

			const meta = sensorMeta.get(sensorId);
			const unit = meta?.unit ? ` ${meta.unit}` : "";
			graph.render(rawRows, hourlyRows, {
				title: `${sensorId}${unit}`,
				trigger: currentTrigger
			});
			saveSessionState(getCurrentSelectionState());
			await loadAlertsLatest();
		} catch (err) {
			console.error(err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setButtonsEnabled(true);
		}
	}

	async function downloadCsv() {
		const deviceId = deviceSelect.value;
		const sensorId = sensorSelect.value;
		const fromIso = toIsoFromDatetimeLocal(fromInput.value);
		const toIso = toIsoFromDatetimeLocal(toInput.value);

		if (!deviceId || !sensorId || !fromIso || !toIso) return;

		setButtonsEnabled(false);
		try {
			// Use JSON paging to avoid parsing CSV cursor comments.
			const rows = await getAllMeasurements(deviceId, sensorId, {
				fromIso,
				toIso,
				limit: 5000
			});

			const header = "ts,seq,value\n";
			const lines = rows.map(r => `${r[0]},${r[1]},${r[2]}`).join("\n");
			const csv = header + lines + "\n";

			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);

			const meta = sensorMeta.get(sensorId);
			const name = `measurements_${formatFilenameSafe(deviceId)}_${formatFilenameSafe(sensorId)}_${formatFilenameSafe(meta?.unit ?? "")}.csv`;
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error(err);
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setButtonsEnabled(true);
		}
	}

	async function loadDevices() {
		try {
			const devices = await getDevices();

			deviceSelect.innerHTML = "<option value=''>Select device</option>";
			for (const d of devices) {
				const opt = document.createElement("option");
				opt.value = d.deviceId;
				opt.textContent = d.location ? `${d.deviceId} (${d.location})` : d.deviceId;
				deviceSelect.appendChild(opt);
			}

			// Default sensor select state until a device is chosen
			sensorSelect.innerHTML = "<option value=''>Select device first</option>";
			sensorSelect.disabled = true;
			fromInput.disabled = true;
			toInput.disabled = true;
			setButtonsEnabled(false);

			triggerBox.hidden = true;
			currentTrigger = null;
		} catch (err) {
			console.error("Failed to load devices", err);
			deviceSelect.innerHTML = "<option value=''>Failed to load devices</option>";
		}
	}

	async function loadSensors(deviceId) {
		sensorSelect.disabled = true;
		sensorSelect.innerHTML = "<option value=''>Loading…</option>";

		fromInput.disabled = true;
		toInput.disabled = true;

		try {
			const sensors = await getSensors(deviceId);

			sensorMeta.clear();
			for (const s of sensors) {
				if (!s?.sensorId) continue;
				sensorMeta.set(s.sensorId, s);
			}

			sensorSelect.innerHTML = "<option value=''>Select sensor</option>";
			for (const s of sensors) {
				const opt = document.createElement("option");
				opt.value = s.sensorId;
				const unit = s.unit ? ` ${s.unit}` : "";
				opt.textContent = s.location ? `${s.sensorId} (${s.location})${unit}` : `${s.sensorId}${unit}`;
				sensorSelect.appendChild(opt);
			}

			sensorSelect.disabled = false;

			if (sensors.length > 0) {
				sensorSelect.value = sensors[0].sensorId;
				applySensorTimeBounds(sensors[0].sensorId);
				updateZoomButtons();
				fromInput.disabled = false;
				toInput.disabled = false;
				setButtonsEnabled(true);
				await loadTrigger(deviceId, sensors[0].sensorId);
			}
			if (sensors.length === 0) {
				setButtonsEnabled(false);
				triggerBox.hidden = true;
				currentTrigger = null;
				updateZoomButtons();
			}
		} catch (err) {
			console.error("Failed to load sensors", err);
			sensorSelect.innerHTML = "<option value=''>Failed to load sensors</option>";
		}
	}

	// --- UI refresh helpers for cache events ---
	async function refreshUiKeepingSelection(opts) {
		// opts: { deviceId?: string|null, sensorId?: string|null, keepFromTo?: boolean }
		const prev = getCurrentSelectionState();
		const targetDeviceId = opts?.deviceId ?? prev.deviceId;
		const targetSensorId = opts?.sensorId ?? prev.sensorId;
		const keepFromTo = opts?.keepFromTo !== false;

		// Preserve from/to (these are session-driven and should stay stable if possible)
		const prevFrom = prev.from;
		const prevTo = prev.to;

		await loadDevices();

		if (targetDeviceId && safeHasOption(deviceSelect, targetDeviceId)) {
			deviceSelect.value = targetDeviceId;
			await loadSensors(targetDeviceId);

			if (targetSensorId && sensorMeta.has(targetSensorId) && safeHasOption(sensorSelect, targetSensorId)) {
				sensorSelect.value = targetSensorId;
				applySensorTimeBounds(targetSensorId);
			}
		}

		if (keepFromTo) {
			if (prevFrom) fromInput.value = prevFrom;
			if (prevTo) toInput.value = prevTo;
		}

		// Clamp restored from/to to sensor bounds if we have a sensor selected.
		const selSensor = sensorSelect.value;
		if (selSensor && sensorMeta.has(selSensor)) {
			applySensorTimeBounds(selSensor);
		}

		ensureFromToOrder();
		updateZoomButtons();

		const sel = getCurrentSelectionState();
		setButtonsEnabled(Boolean(sel.deviceId && sel.sensorId));

		// If we still have a valid full selection, refresh trigger + graph.
		if (sel.deviceId && sel.sensorId && sel.from && sel.to) {
			await loadTrigger(sel.deviceId, sel.sensorId);
			await loadAndRender();
		}
	}

	function installCacheRefreshListeners() {
		// If ApiCache exists, prefer UI-driven refresh (no full page reload).
		if (window.ApiCache && typeof window.ApiCache === "object") {
			try {
				window.ApiCache.autoReloadOnChange = false;
			} catch {
				// ignore
			}
		}

		window.addEventListener("api:devicesUpdated", async () => {
			if (isRefreshingFromCacheEvent) return;
			isRefreshingFromCacheEvent = true;
			try {
				// Devices list changed; reload devices and keep current selection if possible.
				await refreshUiKeepingSelection({ keepFromTo: true });
			} catch (err) {
				console.error("devices cache refresh failed", err);
			} finally {
				isRefreshingFromCacheEvent = false;
			}
		});

		window.addEventListener("api:sensorsUpdated", async (ev) => {
			if (isRefreshingFromCacheEvent) return;
			isRefreshingFromCacheEvent = true;
			try {
				// Detail may include { deviceId }. If it matches current device, refresh sensors only.
				const detail = ev && typeof ev === "object" ? ev.detail : undefined;
				const deviceIdFromEvent = detail && typeof detail.deviceId === "string" ? detail.deviceId : null;
				const curDeviceId = deviceSelect.value || null;

				if (deviceIdFromEvent && curDeviceId && deviceIdFromEvent !== curDeviceId) {
					// Not the currently selected device; no UI update needed.
					return;
				}

				// Sensors changed for current device: refresh UI but keep device/sensor/from/to if possible.
				await refreshUiKeepingSelection({ deviceId: curDeviceId, keepFromTo: true });
			} catch (err) {
				console.error("sensors cache refresh failed", err);
			} finally {
				isRefreshingFromCacheEvent = false;
			}
		});
	}

	deviceSelect.addEventListener("change", () => {
		const deviceId = deviceSelect.value;
		if (!deviceId) {
			sensorSelect.innerHTML = "<option value=''>Select device first</option>";
			sensorSelect.disabled = true;
			fromInput.disabled = true;
			toInput.disabled = true;
			setButtonsEnabled(false);
			triggerBox.hidden = true;
			currentTrigger = null;
			saveSessionState({ deviceId: null, sensorId: null });
			return;
		}
		loadSensors(deviceId);
		saveSessionState({ deviceId, sensorId: null, from: fromInput.value || null, to: toInput.value || null });
	});

	sensorSelect.addEventListener("change", async () => {
		const sensorId = sensorSelect.value;
		if (!sensorId) {
			fromInput.disabled = true;
			toInput.disabled = true;
			triggerBox.hidden = true;
			currentTrigger = null;
			saveSessionState({ sensorId: null });
			return;
		}
		applySensorTimeBounds(sensorId);
		updateZoomButtons();
		saveSessionState({ sensorId, from: fromInput.value || null, to: toInput.value || null });
		fromInput.disabled = false;
		toInput.disabled = false;
		setButtonsEnabled(true);
		await loadTrigger(deviceSelect.value, sensorId);
		await loadAndRender();
	});

	fromInput.addEventListener("change", () => {
		ensureFromToOrder();
		saveSessionState({ from: fromInput.value || null, to: toInput.value || null });
		updateZoomButtons();
	});

	toInput.addEventListener("change", () => {
		ensureFromToOrder();
		saveSessionState({ from: fromInput.value || null, to: toInput.value || null });
		updateZoomButtons();
	});

	loadButton.addEventListener("click", async () => {
		await loadAndRender();
	});

	csvButton.addEventListener("click", async () => {
		await downloadCsv();
	});

	zoomIn10m?.addEventListener("click", async () => { await applyZoom(10 * 60 * 1000, "in"); });
	zoomOut10m?.addEventListener("click", async () => { await applyZoom(10 * 60 * 1000, "out"); });

	zoomIn1h?.addEventListener("click", async () => { await applyZoom(60 * 60 * 1000, "in"); });
	zoomOut1h?.addEventListener("click", async () => { await applyZoom(60 * 60 * 1000, "out"); });

	zoomIn24h?.addEventListener("click", async () => { await applyZoom(24 * 60 * 60 * 1000, "in"); });
	zoomOut24h?.addEventListener("click", async () => { await applyZoom(24 * 60 * 60 * 1000, "out"); });

	alertsRefreshButton?.addEventListener("click", async () => {
		await loadAlertsLatest();
	});

	triggerSaveButton.addEventListener("click", async () => {
		await saveTrigger();
	});

	triggerClearButton.addEventListener("click", async () => {
		await clearTrigger();
	});

	async function restoreSelectionsFromSession() {
		const st = loadSessionState();
		if (!st) return;

		// Restore device if present
		if (st.deviceId) {
			deviceSelect.value = st.deviceId;
			await loadSensors(st.deviceId);

			// Restore sensor if present and exists
			if (st.sensorId && sensorMeta.has(st.sensorId)) {
				sensorSelect.value = st.sensorId;
				applySensorTimeBounds(st.sensorId);
			}
		}

		// Restore from/to if present
		if (st.from) fromInput.value = st.from;
		if (st.to) toInput.value = st.to;

		// Clamp after restoring values
		if (st.sensorId && sensorMeta.has(st.sensorId)) {
			applySensorTimeBounds(st.sensorId);
		}

		ensureFromToOrder();
		updateZoomButtons();

		// If we have a full selection, load trigger + data.
		const sel = getCurrentSelectionState();
		if (sel.deviceId && sel.sensorId && sel.from && sel.to) {
			await loadTrigger(sel.deviceId, sel.sensorId);
			await loadAndRender();
		}
	}

	installCacheRefreshListeners();
	await loadDevices();
	await restoreSelectionsFromSession();
	await loadAlertsLatest();
	updateZoomButtons();
	setButtonsEnabled(Boolean(deviceSelect.value && sensorSelect.value));
})();