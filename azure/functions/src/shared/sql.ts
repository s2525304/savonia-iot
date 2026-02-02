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
	 * Inserts a single telemetry row. Duplicate rows (same PK) are ignored.
	 */
	insertTelemetry: `INSERT INTO telemetry (
			device_id,
			sensor_id,
			ts,
			seq,
			type,
			value_type,
			value_number,
			value_boolean,
			value_text,
			unit,
			location
		)
		VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT DO NOTHING`,

	/**
	 * Build raw telemetry measurements query for a device and sensor within a time range.
	 *
	 * @param whereCursorSql  Additional cursor clause starting with "AND ..." or empty string.
	 * @param limitParamIdx   1-based parameter index for LIMIT (e.g., values.length)
	 */
	buildSelectTelemetryMeasurements(whereCursorSql: string, limitParamIdx: number): string {
		return `SELECT
			ts,
			seq,
			type,
			value_type AS "valueType",
			CASE
				WHEN value_type = 'number'  THEN to_jsonb(value_number)
				WHEN value_type = 'boolean' THEN to_jsonb(value_boolean)
				ELSE to_jsonb(value_text)
			END AS value,
			unit,
			location
		FROM telemetry
		WHERE device_id = $1
			AND sensor_id = $2
			AND ts >= $3::timestamptz
			AND ts <= $4::timestamptz
			${whereCursorSql}
		ORDER BY ts ASC, seq ASC
		LIMIT $${limitParamIdx}::int`;
	},

	/**
	 * Returns the latest known location per device, derived from telemetry.
	 */
	selectDistinctDevices: `SELECT DISTINCT ON (device_id)
		device_id AS "deviceId",
		location AS "location"
	FROM telemetry
	ORDER BY device_id, ts DESC`,

	/**
	 * Returns sensors that have produced telemetry for a given device,
	 * with basic metadata and counts.
	 */
	selectSensorsByDevice: `SELECT
		sensor_id AS "sensorId",
		MIN(type) AS "type",
		MIN(unit) AS "unit",
		MIN(location) AS "location",
		MIN(ts) AS "firstTs",
		MAX(ts) AS "lastTs",
		COUNT(*)::bigint AS "count"
	FROM telemetry
	WHERE device_id = $1
	GROUP BY sensor_id
	ORDER BY sensor_id;`,

	/**
	 * Build hourly aggregates query for a device and sensor within a time range.
	 *
	 * @param whereCursorSql  Additional cursor clause starting with "AND ..." or empty string.
	 * @param limitParamIdx   1-based parameter index for LIMIT (e.g., values.length)
	 */
	buildSelectHourlyAggregates(whereCursorSql: string, limitParamIdx: number): string {
		return `SELECT
			bucket,
			avg_value AS "avgValue",
			min_value AS "minValue",
			max_value AS "maxValue",
			samples
		FROM telemetry_hourly_avg
		WHERE device_id = $1
			AND sensor_id = $2
			AND bucket >= $3::timestamptz
			AND bucket <= $4::timestamptz
			${whereCursorSql}
		ORDER BY bucket ASC
		LIMIT $${limitParamIdx}::int`;
	},

	/**
	 * Optional: refresh concurrently (requires UNIQUE index on the materialized view)
	 */
	refreshTelemetryHourlyAvgConcurrently: "REFRESH MATERIALIZED VIEW CONCURRENTLY telemetry_hourly_avg;",

	/**
	 * Simple sanity query for DB health checks.
	 */
	healthCheck: "SELECT 1;"
} as const;