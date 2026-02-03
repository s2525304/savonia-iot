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

	// sensorId -> sensor metadata (including firstTs/lastTs)
	const sensorMeta = new Map();

	function setButtonsEnabled(enabled) {
		loadButton.disabled = !enabled;
		csvButton.disabled = !enabled;
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

	graph.onZoom(async (tFrom, tTo) => {
		fromInput.value = toDatetimeLocalValue(new Date(tFrom));
		toInput.value = toDatetimeLocalValue(new Date(tTo));
		ensureFromToOrder();
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

		// Default: last 6 hours (clamped to min)
		const defaultTo = new Date(max);
		const defaultFrom = new Date(max);
		defaultFrom.setHours(defaultFrom.getHours() - 6);

		const fromClamped = clampDate(defaultFrom, min, max);
		const toClamped = clampDate(defaultTo, min, max);

		fromInput.value = toDatetimeLocalValue(fromClamped);
		toInput.value = toDatetimeLocalValue(toClamped);

		ensureFromToOrder();
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
				fromInput.disabled = false;
				toInput.disabled = false;
				setButtonsEnabled(true);
				await loadTrigger(deviceId, sensors[0].sensorId);
			}
			if (sensors.length === 0) {
				setButtonsEnabled(false);
				triggerBox.hidden = true;
				currentTrigger = null;
			}
		} catch (err) {
			console.error("Failed to load sensors", err);
			sensorSelect.innerHTML = "<option value=''>Failed to load sensors</option>";
		}
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
			return;
		}
		loadSensors(deviceId);
	});

	sensorSelect.addEventListener("change", async () => {
		const sensorId = sensorSelect.value;
		if (!sensorId) {
			fromInput.disabled = true;
			toInput.disabled = true;
			triggerBox.hidden = true;
			currentTrigger = null;
			return;
		}
		applySensorTimeBounds(sensorId);
		fromInput.disabled = false;
		toInput.disabled = false;
		setButtonsEnabled(true);
		await loadTrigger(deviceSelect.value, sensorId);
		await loadAndRender();
	});

	fromInput.addEventListener("change", () => {
		ensureFromToOrder();
	});

	toInput.addEventListener("change", () => {
		ensureFromToOrder();
	});

	loadButton.addEventListener("click", async () => {
		await loadAndRender();
	});

	csvButton.addEventListener("click", async () => {
		await downloadCsv();
	});

	triggerSaveButton.addEventListener("click", async () => {
		await saveTrigger();
	});

	triggerClearButton.addEventListener("click", async () => {
		await clearTrigger();
	});

	await loadDevices();
	setButtonsEnabled(false);
})();