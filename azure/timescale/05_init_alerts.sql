

-- 05_init_alerts.sql
-- Alerts + alert trigger definitions.
--
-- Goal:
-- - Store alert "rules" (legal parameters / thresholds) per device+sensor.
-- - Store alert instances that open when first out-of-range measurement arrives
--   and close (set end_ts) when an in-range measurement arrives.
--
-- Notes:
-- - Alert open/close logic should be implemented in the ingest path (app layer)
--   or via a DB-side procedure/trigger if desired.
--
-- Conventions:
-- - Timestamps are timestamptz.
-- - "Open" alert: end_ts IS NULL.

-- Trigger / rule definitions ("legal parameters")
CREATE TABLE IF NOT EXISTS alert_triggers (
	id			BIGSERIAL PRIMARY KEY,
	device_id	TEXT NOT NULL,
	sensor_id	TEXT NOT NULL,

	-- Optional rule name for UI/admin
	name		TEXT,

	value_type	TEXT NOT NULL DEFAULT 'number' CHECK (value_type IN ('number', 'boolean', 'string', 'enum')),

	-- Legal range for numeric values. NULL means "no bound".
	min_value	DOUBLE PRECISION NULL,
	max_value	DOUBLE PRECISION NULL,

	-- Whether this trigger is active.
	enabled		BOOLEAN NOT NULL DEFAULT TRUE,

	created_at	TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at	TIMESTAMPTZ NOT NULL DEFAULT NOW(),

	-- Sanity: at least one bound must be set for numeric triggers.
	CONSTRAINT alert_triggers_numeric_bounds_chk
		CHECK (
			value_type <> 'number'
			OR min_value IS NOT NULL
			OR max_value IS NOT NULL
		)
);

-- One active trigger per device+sensor
CREATE UNIQUE INDEX IF NOT EXISTS alert_triggers_device_sensor_unique
	ON alert_triggers (device_id, sensor_id);

CREATE INDEX IF NOT EXISTS alert_triggers_enabled_lookup
	ON alert_triggers (enabled, device_id, sensor_id);


-- Alert instances (opened/closed periods)
CREATE TABLE IF NOT EXISTS alerts (
	id			BIGSERIAL PRIMARY KEY,
	trigger_id	BIGINT NOT NULL REFERENCES alert_triggers(id) ON DELETE RESTRICT,
	device_id	TEXT NOT NULL,
	sensor_id	TEXT NOT NULL,

	-- When the first out-of-range measurement was received
	start_ts	TIMESTAMPTZ NOT NULL,
	-- When the value returned within legal limits (NULL = still open)
	end_ts		TIMESTAMPTZ NULL,

	-- Optional metadata for UI/debugging
	reason		TEXT,
	-- Optional payload snapshot (e.g. offending value) stored as jsonb.
	context		JSONB,

	created_at	TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at	TIMESTAMPTZ NOT NULL DEFAULT NOW(),

	CONSTRAINT alerts_end_after_start_chk CHECK (end_ts IS NULL OR end_ts >= start_ts)
);

-- Common query patterns:
-- 1) latest alerts overall
CREATE INDEX IF NOT EXISTS alerts_start_ts_desc
	ON alerts (start_ts DESC);

-- 2) latest alerts per device/sensor
CREATE INDEX IF NOT EXISTS alerts_device_sensor_start_desc
	ON alerts (device_id, sensor_id, start_ts DESC);

-- 3) quickly find open alert for device/sensor (to close it)
CREATE INDEX IF NOT EXISTS alerts_open_by_device_sensor
	ON alerts (device_id, sensor_id, start_ts DESC)
	WHERE end_ts IS NULL;

-- 4) latest open alerts overall
CREATE INDEX IF NOT EXISTS alerts_open_latest
	ON alerts (start_ts DESC)
	WHERE end_ts IS NULL;

-- Enforce at most one open alert per device+sensor.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_per_device_sensor
	ON alerts (device_id, sensor_id)
	WHERE end_ts IS NULL;


-- Helper view to fetch "latest alerts" with trigger metadata.
CREATE OR REPLACE VIEW alerts_latest AS
SELECT
	a.id,
	a.device_id,
	a.sensor_id,
	a.start_ts,
	a.end_ts,
	a.reason,
	a.context,
	a.created_at,
	a.updated_at,
	t.id AS trigger_id,
	t.name AS trigger_name,
	t.value_type,
	t.min_value,
	t.max_value,
	t.enabled
FROM alerts a
JOIN alert_triggers t ON t.id = a.trigger_id;