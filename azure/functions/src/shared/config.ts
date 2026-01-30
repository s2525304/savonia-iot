import { config as loadEnv } from "dotenv";

// Load .env in local development; in Azure this is a no-op
loadEnv();

export interface TimescaleConfig {
	connectionString: string;
	retentionDays: number;
}

export interface AggregatesConfig {
	refreshCron: string;
}

export interface HttpAuthConfig {
	apiKey: string;
}

export interface BlobWriterConfig {
	connectionString: string;
	container: string;
	tier: "Hot" | "Cool" | "Cold" | "Archive";
	gzip: boolean;
	prefix: string;
}

export interface AppConfig {
	timescale: TimescaleConfig;
	aggregates: AggregatesConfig;
	blobWriter: BlobWriterConfig;
	httpAuth: HttpAuthConfig;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value || value.trim() === "") {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function optionalNumberEnv(name: string, def: number): number {
	const raw = process.env[name];
	if (raw === undefined) return def;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`Environment variable ${name} must be a positive number`);
	}
	return n;
}

function optionalStringEnv(name: string, def: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return def;
	return value;
}

function optionalBooleanEnv(name: string, def: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return def;
	const lower = value.toLowerCase();
	if (lower === "true") return true;
	if (lower === "false") return false;
	throw new Error(`Environment variable ${name} must be "true" or "false"`);
}

export function loadConfig(): AppConfig {
	return {
		timescale: {
			connectionString: requireEnv("TIMESCALE_CONNECTION_STRING"),
			retentionDays: optionalNumberEnv("TIMESCALE_RETENTION_DAYS", 30)
		},
		aggregates: {
			refreshCron: process.env.AGGREGATES_REFRESH_CRON ?? "0 */5 * * * *"
		},
		blobWriter: {
			connectionString: requireEnv("BLOB_STORAGE_CONNECTION_STRING"),
			container: requireEnv("BLOB_CONTAINER_NAME"),
			tier: optionalStringEnv("BLOB_DEFAULT_TIER", "Cool") as
				"Hot" | "Cool" | "Cold" | "Archive",
			gzip: optionalBooleanEnv("BLOB_GZIP", true),
			prefix: optionalStringEnv("BLOB_PREFIX", "telemetry")
		},
		httpAuth: {
			apiKey: requireEnv("HTTP_API_KEY")
		}
	};
}
