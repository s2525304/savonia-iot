import type { InvocationContext, Timer } from "@azure/functions";
import { loadConfig } from "../shared/config";
import { query } from "../shared/db";
import { createLogger } from "../shared/log";
import { Sql } from "../shared/sql";

export async function runAggregates(timer: Timer, context: InvocationContext): Promise<void> {
	const log = createLogger(context);
	const cfg = loadConfig();

	const start = Date.now();
	log.info("Aggregates maintenance starting", {
		scheduleStatus: timer?.scheduleStatus ?? null,
		retentionDays: cfg.timescale.retentionDays
	});

	// 1) Refresh hourly aggregate MV
	const t0 = Date.now();
	await query(Sql.refreshTelemetryHourlyAvg);
	log.info("Refreshed materialized view telemetry_hourly_avg", { ms: Date.now() - t0 });

	// 2) Retention cleanup for raw telemetry
	const t1 = Date.now();
	const interval = `${cfg.timescale.retentionDays} days`;
	const res = await query(Sql.deleteOldTelemetry, [interval]);
	log.info("Retention cleanup complete", { deletedRows: res.rowCount ?? 0, ms: Date.now() - t1 });

	log.info("Aggregates maintenance done", { totalMs: Date.now() - start });
}
