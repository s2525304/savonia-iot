-- 03_init_indexes.sql
-- Indexes for TimescaleDB hot storage
--
-- Must be executed while connected to the 'telemetry' database.

-- Fast lookups by device + sensor over time ranges (most common query)
CREATE INDEX IF NOT EXISTS telemetry_device_sensor_ts_desc
	ON telemetry (device_id, sensor_id, ts DESC);

-- Fast lookups by device across all sensors (e.g. recent activity)
CREATE INDEX IF NOT EXISTS telemetry_device_ts_desc
	ON telemetry (device_id, ts DESC);

-- Optional: filter by type (e.g. only temperature)
CREATE INDEX IF NOT EXISTS telemetry_type
	ON telemetry (type);

-- Optional: find measurements for a sensor across devices (rare, but cheap)
CREATE INDEX IF NOT EXISTS telemetry_sensor_ts_desc
	ON telemetry (sensor_id, ts DESC);

-- Helpful when querying by ingest time (debugging pipelines)
CREATE INDEX IF NOT EXISTS telemetry_ingest_time_desc
	ON telemetry (ingest_time DESC);
