-- 04_init_aggregates.sql
-- Aggregates and maintenance helpers (license-safe)
--
-- NOTE:
-- On Azure Database for PostgreSQL, the packaged TimescaleDB build may run under
-- the Apache license and can DISABLE features like:
--   - Continuous Aggregates (WITH (timescaledb.continuous))
--   - add_continuous_aggregate_policy(...)
--   - add_retention_policy(...)

-- This script creates a plain PostgreSQL Materialized View for hourly aggregates.
-- Refresh is triggered manually or by an external scheduler (e.g. Azure Function Timer).
--
-- Must be executed while connected to the 'telemetry' database.

-- Hourly aggregates per device + sensor (number values only)
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_hourly_avg AS
SELECT
	time_bucket(INTERVAL '1 hour', ts) AS bucket,
	device_id,
	sensor_id,
	AVG(value_number) AS avg_value,
	MIN(value_number) AS min_value,
	MAX(value_number) AS max_value,
	COUNT(*) AS samples
FROM telemetry
WHERE value_type = 'number'
GROUP BY bucket, device_id, sensor_id;

-- Index for fast API queries
CREATE INDEX IF NOT EXISTS telemetry_hourly_avg_lookup
	ON telemetry_hourly_avg (device_id, sensor_id, bucket DESC);
-- Note refresh is triggered by Azure Function Timer