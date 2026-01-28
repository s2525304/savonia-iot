import type winston from "winston";
import { TelemetrySchema } from "@savonia-iot/common";
import type { TelemetryMessageValidated } from "@savonia-iot/common";

import { loadConfig } from "./lib/config";
import { createLogger } from "./lib/log";
import { deleteMeasurement, fetchUnsentBatch, initDb, markFailed, openDb } from "./lib/sqlite";

import { Client, Message } from "azure-iot-device";
import { MqttWs } from "azure-iot-device-mqtt";

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const ERROR_BACKOFF_MS = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

type IoTHubSender = {
	send: (msg: TelemetryMessageValidated) => Promise<void>;
	close: () => Promise<void>;
};

function getIoTHubConnectionString(config: unknown): string {
	const cs = (config as { iotHub?: { connectionString?: string } })?.iotHub?.connectionString?.trim() ?? "";
	if (!cs) {
		throw new Error("IoT Hub connection string missing in config (iotHub.connectionString)");
	}
	if (!cs.includes("DeviceId=")) {
		throw new Error("IoT Hub connection string must contain DeviceId");
	}
	return cs;
}

function createIoTHubSender(logger: winston.Logger, connectionString: string): IoTHubSender {
	const client = Client.fromConnectionString(connectionString, MqttWs);
	logger.info("IoT Hub client created (transport=MqttWs)");

	let opened = false;
	let opening: Promise<void> | null = null;

	const openOnce = async (): Promise<void> => {
		if (opened) return;
		if (opening) return opening;

		opening = new Promise<void>((resolve, reject) => {
			logger.debug("Opening IoT Hub connection...");
			client.open(err => {
				opening = null;
				if (err) {
					logger.error("IoT Hub connection failed: %s", err.message);
					return reject(err);
				}
				logger.info("IoT Hub connection opened");
				opened = true;
				resolve();
			});
		});

		return opening;
	};

	const close = async (): Promise<void> => {
		if (!opened) return;
		logger.debug("Closing IoT Hub connection");
		await new Promise<void>(resolve => {
			client.close(() => resolve());
		});
		opened = false;
		opening = null;
	};

	const send = async (msg: TelemetryMessageValidated): Promise<void> => {
		await openOnce();

		const body = JSON.stringify(msg);
		const m = new Message(body);
		m.contentType = "application/json";
		m.contentEncoding = "utf-8";
		// Helpful for troubleshooting / idempotency on the cloud side.
		m.messageId = `${msg.deviceId}:${msg.sensorId}:${msg.seq}`;

		logger.debug(
			"Sending telemetry to IoT Hub (deviceId=%s sensorId=%s seq=%d)",
			msg.deviceId,
			msg.sensorId,
			msg.seq
		);

		try {
			await new Promise<void>((resolve, reject) => {
				client.sendEvent(m, err => {
					if (err) return reject(err);
					resolve();
				});
			});
		} catch (err) {
			// Force reconnection on the next attempt.
			logger.warn("IoT Hub send failed; will reconnect on next attempt: %s", err instanceof Error ? err.message : String(err));
			await close();
			throw err;
		}
	};

	return { send, close };
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
		serviceName: "measurement-transferrer",
		level: config.logLevel
	});

	const pollIntervalMs = config.transferrer?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
		throw new Error("transferrer.pollIntervalMs must be a positive number");
	}

	logger.info("Measurement transferrer starting (pollIntervalMs=%d)", pollIntervalMs);

	const handle = openDb(config.paths.sqlite);
	initDb(handle.db);

	const connectionString = getIoTHubConnectionString(config);
	const sender = createIoTHubSender(logger, connectionString);

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
				await sender.send(msg);

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
		await sender.close();
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