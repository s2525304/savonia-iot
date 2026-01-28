-- 02_init_schema.sql
-- TimescaleDB hot storage schema
--
-- Must be executed while connected to the 'telemetry' database.
-- Prerequisite: 01_init_extensions.sql (timescaledb extension enabled)

-- Safe to run multiple times.
-- Telemetry measurements (hot storage)
-- One row = one measurement from one sensor at one timestamp.
CREATE TABLE IF NOT EXISTS telemetry (
    ts            TIMESTAMPTZ NOT NULL,
    device_id     TEXT        NOT NULL,
    sensor_id     TEXT        NOT NULL,
    type          TEXT        NOT NULL, -- e.g. "temperature"

    value_type    TEXT        NOT NULL, -- "number" | "boolean" | "enum" | "string"
    value_number  DOUBLE PRECISION,
    value_boolean BOOLEAN,
    value_text    TEXT,

    unit          TEXT,
    location      TEXT,
    seq           BIGINT      NOT NULL,

    ingest_time   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Avoid duplicates if the same measurement is re-sent
    -- (seq helps disambiguate if timestamps collide)
    CONSTRAINT telemetry_pk PRIMARY KEY (device_id, sensor_id, ts, seq),

    -- Minimal value sanity checks
    CONSTRAINT telemetry_value_type_chk CHECK (value_type IN ('number', 'boolean', 'enum', 'string')),

    -- Exactly one value_* column should be used according to value_type
    CONSTRAINT telemetry_value_columns_chk CHECK (
         (value_type = 'number'  AND value_number  IS NOT NULL AND value_boolean IS NULL AND value_text IS NULL) OR
         (value_type = 'boolean' AND value_boolean IS NOT NULL AND value_number  IS NULL AND value_text IS NULL) OR
         (value_type IN ('enum','string') AND value_text IS NOT NULL AND value_number IS NULL AND value_boolean IS NULL)
         )
);

-- Convert to hypertable (idempotent)
-- If you get "already a hypertable", that's OK.
SELECT create_hypertable(
    'telemetry',
    'ts',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);