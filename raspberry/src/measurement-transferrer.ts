import type winston from "winston";
import { TelemetrySchema } from "@savonia-iot/common";
import type { TelemetryMessageValidated } from "@savonia-iot/common";

import { loadConfig } from "./lib/config";
import { createLogger } from "./lib/log";
import { deleteMeasurement, fetchUnsentBatch, initDb, markFailed, openDb } from "./lib/sqlite";

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const ERROR_BACKOFF_MS = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToIoTHubDummy(logger: winston.Logger, msg: TelemetryMessageValidated): Promise<void> {
	// Dummy sender: always succeeds
	// Later: publish MQTT message to Azure IoT Hub
	logger.info("(dummy) would send telemetry: %s", JSON.stringify(msg));
	return;
}

function parseTelemetryMessage(payloadJson: string): TelemetryMessageValidated {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson) as unknown;
	} catch (e) {
		throw new Error("Invalid JSON in payloadJson");
	}

	const res = TelemetrySchema.safeParse(parsed);
	if (!res.success) {
		// Keep the error compact so it fits into DB columns/logs.
		const issues = res.error.issues
			.slice(0, 5)
			.map(i => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
			.join("; ");
		throw new Error(`Telemetry schema validation failed: ${issues}`);
	}

	return res.data;
}

async function main(): Promise<void> {
	const config = loadConfig();

	const logger: winston.Logger = createLogger({
		logDir: config.paths.logDir,
		serviceName: "measurement-transferrer"
	});

	const pollIntervalMs = config.transferrer?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
		throw new Error("transferrer.pollIntervalMs must be a positive number");
	}

	logger.info("Measurement transferrer starting (pollIntervalMs=%d)", pollIntervalMs);

	const handle = openDb(config.paths.sqlite);
	initDb(handle.db);

	let running = true;
	const stopGraceful = (signal: string) => {
		logger.info("Stopping measurement transferrer (signal=%s)", signal);
		running = false;
	};

	const stopImmediate = (signal: string) => {
		logger.info("Immediate stop requested (signal=%s)", signal);
		process.exit(0);
	};

	process.on("SIGINT", () => stopImmediate("SIGINT")); // Ctrl+C
	process.on("SIGTERM", () => stopGraceful("SIGTERM")); // systemd stop

	try {
		while (running) {
			// Send strictly one-by-one: fetch the oldest unsent row
			const rows = fetchUnsentBatch(handle.db, 1);

			if (rows.length === 0) {
				await sleep(pollIntervalMs);
				continue;
			}

			const row = rows[0];

			try {
				const msg = parseTelemetryMessage(row.payloadJson);
				await sendToIoTHubDummy(logger, msg);

				// Success: delete measurement from the local buffer
				deleteMeasurement(handle.db, row.id);
				logger.info("Sent and deleted measurement id=%d", row.id);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				markFailed(handle.db, row.id, msg);
				logger.error("Failed to send measurement id=%d error=%s", row.id, msg);

				// Avoid busy-looping on repeated failures
				await sleep(Math.min(ERROR_BACKOFF_MS, pollIntervalMs));
			}
		}
	} finally {
		handle.close();
		logger.info("Measurement transferrer exiting");
	}
}

main()
	.then(() => process.exit(0))
	.catch(err => {
		console.error(err);
		process.exit(1);
	});