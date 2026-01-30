import { app } from "@azure/functions";
import { loadConfig } from "./shared/config";
import { runAggregates } from "./functions/aggregates";
import { runTimescaleWriter } from "./functions/timescale-writer";
import { runBlobWriter } from "./functions/blob-writer";
import { getDevices } from "./functions/http/devices.get";
import { getSensors } from "./functions/http/sensors.get";
import { getMeasurements } from "./functions/http/measurements.get";
import { getHourly } from "./functions/http/hourly.get";

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

/*
	EventHub triggered functions must have different consumerGroups, or
	otherwise they will compete for the same messages.
 */
app.eventHub("timescale-writer", {
	eventHubName: "iothub-ehub-*",
	connection: "IOT_HUB_EVENTHUB_CONNECTION",
	consumerGroup: "timescale-writer",
	cardinality: "many",
	handler: runTimescaleWriter
});

app.eventHub("blob-writer", {
	eventHubName: "iothub-ehub-*",
	connection: "IOT_HUB_EVENTHUB_CONNECTION",
	consumerGroup: "blob-writer",
	cardinality: "many",
	handler: runBlobWriter
});

app.http("devices-get", {
	methods: ["GET"],
	authLevel: "anonymous",
	route: "devices",
	handler: getDevices
});

app.http("sensors-get", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "devices/{deviceId}/sensors",
    handler: getSensors
});

app.http("measurements-get", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "devices/{deviceId}/sensors/{sensorId}/measurements",
    handler: getMeasurements
});

app.http("hourly-get", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "devices/{deviceId}/sensors/{sensorId}/hourly",
    handler: getHourly
});
