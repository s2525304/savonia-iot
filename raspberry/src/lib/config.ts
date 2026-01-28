import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";

export type ValueType = "number" | "boolean" | "enum";

export type LogLevel = "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly" | "auth";

export interface SensorConfig {
    sensorId: string;
    type: string;
    valueType?: ValueType;
    unit?: string;
    location?: string;
	driver?: "gpio" | "i2c" | "pi_cpu_temp";

    intervalMs: number;

    // Sensor settings
    gpio?: number;
    i2cAddress?: number;
    enumValues?: string[];
}

export interface AppConfig {
    device: {
        deviceId: string; // derived from IOT_HUB_CONNECTION
        location?: string;
    };

	iotHub: {
		connectionString: string;
	};

    paths: {
        sqlite: string;
        logDir: string;
    };

	logLevel: LogLevel;

	transferrer?: {
		pollIntervalMs?: number;
	};

    sensors: SensorConfig[];
}

/* ---------- defaults ---------- */

const DEFAULT_SQLITE = "/var/lib/savonia-iot/buffer.sqlite";
const DEFAULT_LOG_DIR = "/var/log/savonia-iot";
const DEFAULT_LOG_LEVEL: LogLevel = "info";

function parseCommandLine(): { configPath: string } {
	const program = new Command();

	program
		.requiredOption("-c, --config <path>", "Path to configuration file")
		.allowUnknownOption(true)
		.allowExcessArguments(true);

	program.parse(process.argv);

	const opts = program.opts<{ config: string }>();
	return { configPath: opts.config };
}

function ensureDir(p: string): void {
    fs.mkdirSync(p, { recursive: true });
}

function applySensorDefaults(s: SensorConfig, deviceLocation?: string): SensorConfig {
	const out: SensorConfig = { ...s };

	// If not specified, inherit the location from the device
	if (!out.location && deviceLocation) {
		out.location = deviceLocation;
	}

	return out;
}

function getIotHubConnectionFromEnv(): { connectionString: string; deviceId: string } {
	const connectionString = (process.env.IOT_HUB_CONNECTION ?? "").trim();
	if (!connectionString) {
		throw new Error("IOT_HUB_CONNECTION environment variable is required");
	}
	const parts = connectionString.split(";");
	const deviceIdPart = parts.find(p => p.startsWith("DeviceId="));
	const deviceId = deviceIdPart ? deviceIdPart.substring("DeviceId=".length) : "";
	if (!deviceId) {
		throw new Error("IOT_HUB_CONNECTION must contain DeviceId");
	}
	return { connectionString, deviceId };
}

/* ---------- validation ---------- */

function validateConfig(cfg: AppConfig): void {
	if (!cfg.iotHub?.connectionString?.trim()) {
		throw new Error("config.iotHub.connectionString is required");
	}
	if (!cfg.iotHub.connectionString.includes("DeviceId=")) {
		throw new Error("config.iotHub.connectionString must contain DeviceId");
	}

	const allowedLogLevels: ReadonlySet<string> = new Set([
		"error",
		"warn",
		"info",
		"http",
		"verbose",
		"debug",
		"silly",
		"auth"
	]);
	if (!allowedLogLevels.has(cfg.logLevel)) {
		throw new Error(`config.logLevel must be one of: ${Array.from(allowedLogLevels).join(", ")}`);
	}

    if (!cfg.sensors || cfg.sensors.length === 0) {
        throw new Error("config.sensors must contain at least one sensor");
    }

	if (cfg.transferrer?.pollIntervalMs !== undefined) {
		if (!Number.isFinite(cfg.transferrer.pollIntervalMs) || cfg.transferrer.pollIntervalMs <= 0) {
			throw new Error("config.transferrer.pollIntervalMs must be a positive number");
		}
	}

    for (const s of cfg.sensors) {
        if (!s.sensorId) throw new Error("sensor.sensorId is required");
        if (!s.type) throw new Error(`sensor ${s.sensorId}: type missing`);
        if (!s.intervalMs || s.intervalMs <= 0) {
            throw new Error(`sensor ${s.sensorId}: invalid intervalMs`);
        }

        if (s.valueType === "enum" && (!s.enumValues || s.enumValues.length === 0)) {
            throw new Error(`sensor ${s.sensorId}: enumValues required for enum sensor`);
        }
    }
}

/* ---------- public API ---------- */

export function loadConfig(): AppConfig {
    const { configPath } = parseCommandLine();

    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig> & { logLevel?: string };

	const { connectionString, deviceId } = getIotHubConnectionFromEnv();

    const cfg: AppConfig = {
        device: {
            deviceId,
            location: parsed.device?.location
        },
		iotHub: {
			connectionString
		},
        paths: {
            sqlite: parsed.paths?.sqlite ?? DEFAULT_SQLITE,
            logDir: parsed.paths?.logDir ?? DEFAULT_LOG_DIR
        },
		logLevel: (parsed as any).logLevel ?? DEFAULT_LOG_LEVEL,
		transferrer: {
			pollIntervalMs: parsed.transferrer?.pollIntervalMs
		},
		sensors: (parsed.sensors ?? []).map(s => applySensorDefaults(s as SensorConfig, parsed.device?.location))
    };

    validateConfig(cfg);

    // Verify that dirs exist
    ensureDir(path.dirname(cfg.paths.sqlite));
    ensureDir(cfg.paths.logDir);

    return cfg;
}