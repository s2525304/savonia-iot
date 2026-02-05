-- Savonia IoT / TimescaleDB schema bootstrap
--
-- NOTE:
-- The database itself is created by the infra script (40-postgres.sh) using the
-- POSTGRES_DATABASE value from azure.env. This SQL is executed *inside* that
-- database (psql --dbname "$POSTGRES_DATABASE"), so attempting to CREATE DATABASE
-- here would either be redundant or fail.
--
-- Kept as a no-op placeholder so the numbered schema sequence remains stable.

SELECT 1;