import { Command } from "commander";

import { loadConfig } from "./lib/config";
import type { AppConfig, SensorConfig, ValueType } from "./lib/config";

import { createLogger } from "./lib/log";
import type winston from "winston";

import type Database from "better-sqlite3";

import { getSensorModule } from "./sensors";
import { buildPayload, initDb, insertMeasurement, nextSeq, openDb } from "./lib/sqlite";

interface CliOptions {
	sensorId: string;
}

interface Context {
	sensorId: string;
	config: AppConfig;
	logger: winston.Logger;
	sensor: SensorConfig;
	db?: Database.Database;
	dbClose?: () => void;
}

function parseCommandLine(): CliOptions {
	const program = new Command();

	program
		.option("-c, --config <path>", "Path to configuration file (parsed by config.ts)")
		.requiredOption("-s, --sensorId <id>", "Sensor ID to read")
		.allowUnknownOption(true)
		.allowExcessArguments(true);

	program.parse(process.argv);

	const opts = program.opts<CliOptions>();
	return { sensorId: opts.sensorId };
}

async function loadConfigAndInitLogger(): Promise<{ sensorId: string; config: AppConfig; logger: winston.Logger }> {
	const { sensorId } = parseCommandLine();
	const config = loadConfig();

	const logger = createLogger({
		logDir: config.paths.logDir,
		serviceName: `sensor-reader-${sensorId}`
	});

	return { sensorId, config, logger };
}

function selectSensorOrThrow(config: AppConfig, sensorId: string): SensorConfig {
	const sensor = config.sensors.find(s => s.sensorId === sensorId);
	if (!sensor) {
		throw new Error(`Unknown sensorId '${sensorId}'`);
	}
	return sensor;
}

async function openAndInitDb(ctx: Context): Promise<void> {
	const handle = openDb(ctx.config.paths.sqlite);
	initDb(handle.db);
	ctx.db = handle.db;
	ctx.dbClose = handle.close;
}

async function readSensorValue(ctx: Context): Promise<{ valueType: ValueType; value: number | boolean | string }> {
	const module = getSensorModule(ctx.sensor.type);

	// Apply sensor-specific defaults (e.g. valueType, unit)
	module.defaults?.(ctx.sensor);

	if (!ctx.sensor.valueType) {
		throw new Error(`Sensor '${ctx.sensor.sensorId}' did not define valueType after defaults()`);
	}

	module.validate(ctx.sensor);

	const result = await module.read(ctx.sensor);

	return {
		valueType: result.valueType,
		value: result.value
	};
}

async function persistMeasurement(ctx: Context, valueType: ValueType, value: number | boolean | string): Promise<void> {
	if (!ctx.db) {
		throw new Error("DB not initialized");
	}

	// Ensure the payload uses the sensor's configured valueType (after defaults)
	if (ctx.sensor.valueType !== valueType) {
		ctx.logger.warn(
			"ValueType mismatch: sensor config=%s read=%s; using read valueType",
			ctx.sensor.valueType,
			valueType
		);
	}

	const deviceId = ctx.config.device.deviceId;
	const seq = nextSeq(ctx.db, deviceId, ctx.sensor.sensorId);
	const ts = new Date();

	const payload = buildPayload({
		deviceId,
		sensor: ctx.sensor,
		valueType,
		ts,
		seq,
		value
	});

	insertMeasurement(ctx.db, payload);
	ctx.logger.info(
		"Inserted measurement: sensorId=%s ts=%s seq=%d valueType=%s value=%s unit=%s",
		payload.sensorId,
		payload.ts,
		payload.seq,
		payload.valueType,
		String(value),
		payload.unit ?? "-"
	);
}

async function main(): Promise<void> {
	const { sensorId, config, logger } = await loadConfigAndInitLogger();
	const sensor = selectSensorOrThrow(config, sensorId);

	// Apply sensor defaults + validate EARLY so logs reflect final config
	const module = getSensorModule(sensor.type);
	module.defaults?.(sensor);
	if (!sensor.valueType) {
		throw new Error(`Sensor '${sensor.sensorId}' did not define valueType after defaults()`);
	}
	module.validate(sensor);

	const ctx: Context = {
		sensorId,
		config,
		logger,
		sensor
	};

	logger.info("Sensor reader starting (one-shot)");
	logger.info("deviceId=%s", config.device.deviceId);
	logger.info(
		"Selected sensor: id=%s type=%s valueType=%s intervalMs=%d unit=%s",
		sensor.sensorId,
		sensor.type,
		sensor.valueType,
		sensor.intervalMs,
		sensor.unit ?? "-"
	);

	try {
		await openAndInitDb(ctx);
		const { valueType, value } = await readSensorValue(ctx);
		await persistMeasurement(ctx, valueType, value);
	} finally {
		ctx.dbClose?.();
	}

	logger.info("Sensor reader exiting (one-shot)");
}

main()
	.then(() => process.exit(0))
	.catch(err => {
		console.error(err);
		process.exit(1);
	});
