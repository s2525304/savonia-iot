-- 01_init_extensions.sql
-- Enables required TimescaleDB extensions for the Savonia IoT project
-- This script is safe to run multiple times.

-- MUST be executed in the application database (e.g. telemetry),
-- not in the default 'postgres' database.

-- On Azure portal  add timescaledb extension to azure.extensions
-- On Azure add timescaledb to shared_preload_libraries

CREATE EXTENSION IF NOT EXISTS timescaledb;