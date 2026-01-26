import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import type { SensorConfig, ValueType } from "./config";

export interface DbHandle {
	db: Database.Database;
	close: () => void;
}

export interface MeasurementPayload {
	schemaVersion: number;
	deviceId: string;
	sensorId: string;
	type: string;
	valueType: ValueType;
	value: number | boolean | string;
	unit?: string;
	location?: string;
	ts: string; // ISO8601
	seq: number;
}

function ensureDir(p: string): void {
	fs.mkdirSync(p, { recursive: true });
}

export function openDb(sqlitePath: string): DbHandle {
	ensureDir(path.dirname(sqlitePath));

	const db = new Database(sqlitePath);

	// Concurrency-friendly settings for the 2-process model (producer + consumer)
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");

	return {
		db,
		close: () => db.close()
	};
}

export function initDb(db: Database.Database): void {
	const tx = db.transaction(() => {
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		const ver = row?.user_version ?? 0;

		if (ver === 0) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS measurements (
					id              INTEGER PRIMARY KEY AUTOINCREMENT,
					schemaVersion   INTEGER NOT NULL,
					deviceId        TEXT    NOT NULL,
					sensorId        TEXT    NOT NULL,
					type            TEXT    NOT NULL,
					valueType       TEXT    NOT NULL CHECK (valueType IN ('number','boolean','enum')),
					valueNumber     REAL,
					valueBoolean    INTEGER CHECK (valueBoolean IN (0,1)),
					valueText       TEXT,
					unit            TEXT,
					location        TEXT,
					ts              TEXT    NOT NULL,
					seq             INTEGER NOT NULL,
					payloadJson     TEXT    NOT NULL,
					createdAt       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
					sentAt          TEXT,
					retryCount      INTEGER NOT NULL DEFAULT 0,
					lastError       TEXT,
					UNIQUE(deviceId, sensorId, ts, seq),
					CHECK (
						(valueType='number'  AND valueNumber  IS NOT NULL AND valueBoolean IS NULL AND valueText IS NULL) OR
						(valueType='boolean' AND valueBoolean IS NOT NULL AND valueNumber  IS NULL AND valueText IS NULL) OR
						(valueType='enum'    AND valueText    IS NOT NULL AND valueNumber  IS NULL AND valueBoolean IS NULL)
					)
				);

				CREATE INDEX IF NOT EXISTS idx_measurements_unsent
				ON measurements (sentAt, ts);

				CREATE INDEX IF NOT EXISTS idx_measurements_sensor_ts
				ON measurements (sensorId, ts);

				CREATE TABLE IF NOT EXISTS sensor_seq (
					deviceId TEXT NOT NULL,
					sensorId TEXT NOT NULL,
					lastSeq  INTEGER NOT NULL,
					PRIMARY KEY (deviceId, sensorId)
				);
			`);

			db.pragma("user_version = 2");
		} else if (ver === 1) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS sensor_seq (
					deviceId TEXT NOT NULL,
					sensorId TEXT NOT NULL,
					lastSeq  INTEGER NOT NULL,
					PRIMARY KEY (deviceId, sensorId)
				);
			`);

			db.pragma("user_version = 2");
		}
	});

	tx();
}

export function nextSeq(db: Database.Database, deviceId: string, sensorId: string): number {
	const tx = db.transaction(() => {
		// Ensure a row exists
		db.prepare(
			"INSERT OR IGNORE INTO sensor_seq (deviceId, sensorId, lastSeq) VALUES (?, ?, 0)"
		).run(deviceId, sensorId);

		// Read current
		const row = db
			.prepare("SELECT lastSeq FROM sensor_seq WHERE deviceId=? AND sensorId=?")
			.get(deviceId, sensorId) as { lastSeq: number };

		const next = (row?.lastSeq ?? 0) + 1;

		// Persist
		db.prepare("UPDATE sensor_seq SET lastSeq=? WHERE deviceId=? AND sensorId=?").run(next, deviceId, sensorId);

		return next;
	});

	return tx();
}

export function buildPayload(params: {
	deviceId: string;
	sensor: SensorConfig;
	valueType: ValueType;
	ts: Date;
	seq: number;
	value: number | boolean | string;
}): MeasurementPayload {
	if (!params.valueType) {
		throw new Error("buildPayload: valueType is required");
	}
	return {
		schemaVersion: 1,
		deviceId: params.deviceId,
		sensorId: params.sensor.sensorId,
		type: params.sensor.type,
		valueType: params.valueType,
		value: params.value,
		unit: params.sensor.unit,
		location: params.sensor.location,
		ts: params.ts.toISOString(),
		seq: params.seq
	};
}

export function insertMeasurement(db: Database.Database, payload: MeasurementPayload): void {
	const stmt = db.prepare(`
		INSERT INTO measurements (
			schemaVersion, deviceId, sensorId, type, valueType,
			valueNumber, valueBoolean, valueText,
			unit, location, ts, seq, payloadJson
		) VALUES (
			@schemaVersion, @deviceId, @sensorId, @type, @valueType,
			@valueNumber, @valueBoolean, @valueText,
			@unit, @location, @ts, @seq, @payloadJson
		)
	`);

	const tx = db.transaction(() => {
		const params = {
			schemaVersion: payload.schemaVersion,
			deviceId: payload.deviceId,
			sensorId: payload.sensorId,
			type: payload.type,
			valueType: payload.valueType,
			valueNumber: payload.valueType === "number" ? (payload.value as number) : null,
			valueBoolean: payload.valueType === "boolean" ? ((payload.value as boolean) ? 1 : 0) : null,
			valueText: payload.valueType === "enum" ? String(payload.value) : null,
			unit: payload.unit ?? null,
			location: payload.location ?? null,
			ts: payload.ts,
			seq: payload.seq,
			payloadJson: JSON.stringify(payload)
		};

		stmt.run(params);
	});

	tx();
}

export interface UnsentRow {
	id: number;
	payloadJson: string;
	retryCount: number;
}

export function fetchUnsentBatch(db: Database.Database, limit: number): UnsentRow[] {
	return db
		.prepare(
			"SELECT id, payloadJson, retryCount FROM measurements WHERE sentAt IS NULL ORDER BY ts ASC LIMIT ?"
		)
		.all(limit) as UnsentRow[];
}

export function markSent(db: Database.Database, id: number, sentAtIso: string): void {
	db.prepare("UPDATE measurements SET sentAt=?, lastError=NULL WHERE id=?").run(sentAtIso, id);
}

export function markFailed(db: Database.Database, id: number, error: string): void {
	db.prepare("UPDATE measurements SET retryCount=retryCount+1, lastError=? WHERE id=?").run(error, id);
}

export function deleteMeasurement(db: Database.Database, id: number): void {
	db.prepare("DELETE FROM measurements WHERE id=?").run(id);
}

export function deleteSentOlderThan(db: Database.Database, olderThanIso: string): number {
	const res = db.prepare("DELETE FROM measurements WHERE sentAt IS NOT NULL AND sentAt < ?").run(olderThanIso);
	return Number(res.changes ?? 0);
}
