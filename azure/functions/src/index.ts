import { app } from "@azure/functions";
import { loadConfig } from "./shared/config";
import { runAggregates } from "./functions/aggregates";
import { runTimescaleWriter } from "./functions/timescale-writer";
import { runBlobWriter } from "./functions/blob-writer";

function getSchedule(): string {
	// Try to read schedule from env; fallback keeps host alive even if env missing.
	// The handler itself will still validate config properly.
	try {
		return loadConfig().aggregates.refreshCron;
	} catch {
		// Safe default (every 5 minutes) to avoid "0 functions loaded" during startup.
		return "0 */5 * * * *";
	}
}

app.timer("aggregates", {
	schedule: getSchedule(),
	handler: async (myTimer, context) => {
		// Validate config when the function actually runs
		return runAggregates(myTimer, context);
	},
	runOnStartup: false,
	useMonitor: true
});

app.eventHub("timescale-writer", {
	eventHubName: "iothub-ehub-*",
	connection: "IOT_HUB_EVENTHUB_CONNECTION",
	cardinality: "many",
	handler: runTimescaleWriter
});

app.eventHub("blob-writer", {
	eventHubName: "iothub-ehub-*",
	connection: "IOT_HUB_EVENTHUB_CONNECTION",
	cardinality: "many",
	handler: runBlobWriter
});