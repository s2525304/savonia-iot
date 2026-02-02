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
	prefix: string;
	gzip: boolean;
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

function buildPostgresConnectionString(): string {
	const host = requireEnv("POSTGRES_HOST");
	const port = requireEnv("POSTGRES_PORT");
	const database = requireEnv("POSTGRES_DATABASE");
	const user = requireEnv("POSTGRES_USER");
	const password = requireEnv("POSTGRES_PASSWORD");
	const sslmode = process.env.POSTGRES_SSLMODE ?? "require";

	// Encode user/password safely for URI usage
	const encUser = encodeURIComponent(user);
	const encPass = encodeURIComponent(password);

	let cs = `postgresql://${encUser}:${encPass}@${host}:${port}/${database}`;

	// Azure PostgreSQL requires SSL; pg uses ssl option but we keep sslmode for completeness
	if (sslmode) {
		cs += `?sslmode=${encodeURIComponent(sslmode)}`;
	}

	return cs;
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
			connectionString: buildPostgresConnectionString(),
			retentionDays: optionalNumberEnv("TIMESCALE_RETENTION_DAYS", 30)
		},
		aggregates: {
			refreshCron: process.env.AGGREGATES_REFRESH_CRON ?? "0 */5 * * * *"
		},
		blobWriter: {
			connectionString: requireEnv("COLD_STORAGE_CONNECTION_STRING"),
			container: requireEnv("COLD_CONTAINER"),
			prefix: optionalStringEnv("COLD_PREFIX", "telemetry"),
			gzip: optionalBooleanEnv("COLD_GZIP", false)
		},
		httpAuth: {
			apiKey: requireEnv("HTTP_API_KEY")
		}
	};
}
