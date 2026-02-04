import type { InvocationContext } from "@azure/functions";

import { query } from "../shared/db";
import { Sql } from "../shared/sql";

type TriggerRow = {
	id: number;
	minValue: number | null;
	maxValue: number | null;
	enabled: boolean;
};

type AlertRow = {
	id: number;
	triggerId: number;
	deviceId: string;
	sensorId: string;
	startTs: string;
	endTs: string | null;
	reason: string | null;
	context: any;
};

type TelemetryMessage = {
	deviceId?: string;
	sensorId?: string;
	ts?: string;
	seq?: number;
	valueType?: string;
	value?: unknown;
	// tolerate alternate casing just in case
	device_id?: string;
	sensor_id?: string;
	value_type?: string;
};

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function toNumber(v: unknown): number | null {
	if (isFiniteNumber(v)) return v;
	if (typeof v === "string") {
		const s = v.trim().replace(",", ".");
		if (!s) return null;
		const n = Number(s);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function parseMessage(m: unknown): { deviceId: string; sensorId: string; tsIso: string; seq: number; value: number } | null {
	if (!m || typeof m !== "object") return null;
	const msg = m as TelemetryMessage;

	const deviceId = msg.deviceId ?? msg.device_id;
	const sensorId = msg.sensorId ?? msg.sensor_id;
	const tsIso = msg.ts;
	const seq = typeof msg.seq === "number" ? msg.seq : 0;
	const valueType = (msg.valueType ?? msg.value_type ?? "").toLowerCase();

	if (!deviceId || !sensorId || !tsIso) return null;
	if (valueType && valueType !== "number") return null;

	// Most producers send `value` already decoded as JSON.
	const value = toNumber(msg.value);
	if (value === null) return null;

	// Validate timestamp
	const d = new Date(tsIso);
	if (Number.isNaN(d.getTime())) return null;

	return { deviceId, sensorId, tsIso, seq, value };
}

function buildReason(sensorId: string, value: number, min: number | null, max: number | null): string {
	if (min !== null && max !== null) {
		if (value < min) return `${sensorId}: value ${value} is below min ${min}`;
		if (value > max) return `${sensorId}: value ${value} is above max ${max}`;
		return `${sensorId}: value ${value} is outside range [${min}, ${max}]`;
	}
	if (min !== null) return `${sensorId}: value ${value} is below min ${min}`;
	if (max !== null) return `${sensorId}: value ${value} is above max ${max}`;
	return `${sensorId}: value ${value} is out of bounds`;
}

function getLastOobTs(alert: AlertRow): Date {
	const ctx = (alert.context ?? {}) as any;
	const raw = ctx.lastOutOfBoundsTs;
	const d = raw ? new Date(String(raw)) : new Date(alert.startTs);
	return Number.isNaN(d.getTime()) ? new Date(alert.startTs) : d;
}

function addMinutes(d: Date, minutes: number): Date {
	return new Date(d.getTime() + minutes * 60_000);
}

async function getEnabledTrigger(deviceId: string, sensorId: string): Promise<TriggerRow | null> {
	const res = await query(Sql.selectEnabledAlertTriggerByDeviceSensor, [deviceId, sensorId]);
	const row = res.rows?.[0] as TriggerRow | undefined;
	if (!row) return null;
	if (!row.enabled) return null;
	return row;
}

async function getOpenAlert(triggerId: number): Promise<AlertRow | null> {
	const res = await query(Sql.selectOpenAlertByTriggerId, [triggerId]);
	const row = res.rows?.[0] as AlertRow | undefined;
	return row ?? null;
}

async function createAlert(triggerId: number, deviceId: string, sensorId: string, tsIso: string, value: number, min: number | null, max: number | null): Promise<void> {
	const reason = buildReason(sensorId, value, min, max);
	const context = {
		value,
		min,
		max,
		lastOutOfBoundsTs: tsIso
	};
	await query(Sql.insertAlert, [triggerId, deviceId, sensorId, tsIso, reason, context]);
}

async function touchAlertOutOfBounds(alertId: number, tsIso: string, value: number, min: number | null, max: number | null): Promise<void> {
	const context = {
		value,
		min,
		max,
		lastOutOfBoundsTs: tsIso
	};
	await query(Sql.updateAlertContext, [alertId, context]);
}

async function maybeCloseAlert(alert: AlertRow, measurementTsIso: string): Promise<boolean> {
	const lastOob = getLastOobTs(alert);
	const closeAfter = addMinutes(lastOob, 10);
	const measurementTs = new Date(measurementTsIso);
	if (Number.isNaN(measurementTs.getTime())) return false;

	// Only clear after 10 minutes have passed since the last out-of-bounds measurement,
	// using *measurement timestamps*, not wall clock.
	if (measurementTs.getTime() >= closeAfter.getTime()) {
		await query(Sql.closeAlert, [alert.id, measurementTsIso]);
		return true;
	}

	return false;
}

/**
 * Queue trigger handler: process validated telemetry messages from the alert queue.
 *
 * Rules:
 * - Create an alert when the first out-of-range measurement is received.
 * - Keep the alert open until 10 minutes have passed since the last out-of-range measurement.
 * - The 10-minute timer uses the telemetry `ts` field (measurement time), not real time.
 */
export async function alert(queueItem: unknown, context: InvocationContext): Promise<void> {
	let raw: unknown = queueItem;

	// Storage Queue trigger bindings sometimes pass a string; tolerate both.
	if (typeof queueItem === "string") {
		try {
			raw = JSON.parse(queueItem);
		} catch {
			context.warn?.("alert: invalid JSON message");
			return;
		}
	}

	const msg = parseMessage(raw);
	if (!msg) {
		context.log("alert: skipped non-numeric or malformed message");
		return;
	}

	const { deviceId, sensorId, tsIso, seq, value } = msg;

	let trigger: TriggerRow | null;
	try {
		trigger = await getEnabledTrigger(deviceId, sensorId);
	} catch (err) {
		context.error("alert: failed to read trigger", { deviceId, sensorId });
		throw err instanceof Error ? err : new Error(String(err));
	}

	if (!trigger) {
		// No enabled trigger configured for this sensor.
		return;
	}

	const min = trigger.minValue;
	const max = trigger.maxValue;
	const outOfBounds =
		(min !== null && value < min) ||
		(max !== null && value > max);

	context.log("alert: measurement", {
		deviceId,
		sensorId,
		ts: tsIso,
		seq,
		value,
		triggerId: trigger.id,
		min,
		max,
		outOfBounds
	});

	const open = await getOpenAlert(trigger.id);

	if (outOfBounds) {
		if (!open) {
			await createAlert(trigger.id, deviceId, sensorId, tsIso, value, min, max);
			context.log("alert: created", { deviceId, sensorId, ts: tsIso, triggerId: trigger.id });
			return;
		}

		// Reset the clear timer by updating lastOutOfBoundsTs.
		await touchAlertOutOfBounds(open.id, tsIso, value, min, max);
		context.log("alert: updated (still out of bounds)", { alertId: open.id, ts: tsIso });
		return;
	}

	// Legal value. If an alert is open, close it only after 10 minutes since the last OOB.
	if (open) {
		const closed = await maybeCloseAlert(open, tsIso);
		if (closed) {
			context.log("alert: closed", { alertId: open.id, ts: tsIso });
		}
	}
}
