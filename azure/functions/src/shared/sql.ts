

/**
 * Shared SQL snippets used by multiple Azure Functions.
 */

export const Sql = {
	/**
	 * Refreshes the hourly aggregates materialized view.
	 *
	 * If you later add a UNIQUE index on (device_id, sensor_id, bucket), you can switch to
	 * REFRESH MATERIALIZED VIEW CONCURRENTLY for less blocking.
	 */
	refreshTelemetryHourlyAvg: "REFRESH MATERIALIZED VIEW telemetry_hourly_avg;",

	/**
	 * Deletes raw telemetry older than a given interval (e.g. '30 days').
	 * Parameter: $1 = interval text
	 */
	deleteOldTelemetry: "DELETE FROM telemetry WHERE ts < now() - ($1::text)::interval;",

	/**
	 * Optional: refresh concurrently (requires UNIQUE index on the materialized view)
	 */
	refreshTelemetryHourlyAvgConcurrently: "REFRESH MATERIALIZED VIEW CONCURRENTLY telemetry_hourly_avg;",

	/**
	 * Simple sanity query for DB health checks.
	 */
	healthCheck: "SELECT 1;"
} as const;