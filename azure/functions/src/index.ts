import { app } from "@azure/functions";
import { loadConfig } from "./shared/config";
import { runTimescaleWriter } from "./functions/timescale-writer";
import { runAggregates } from "./functions/aggregates";
import { runBlobWriter } from "./functions/blob-writer";
import { getDevices } from "./functions/http/devices.get";
import { getSensors } from "./functions/http/sensors.get";
import { getMeasurements } from "./functions/http/measurements.get";
import { getHourly } from "./functions/http/hourly.get";
import { getTrigger } from "./functions/http/trigger.get";
import { ingest } from "./functions/ingest";

app.timer("aggregates", {
	schedule: loadConfig().aggregates.refreshCron,
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


app.eventHub("ingest", {
	eventHubName: "%EVENTHUB_NAME%",
	connection: "EVENTHUB_CONNECTION_STRING",
	consumerGroup: "%EVENTHUB_CONSUMERGROUP%",
	cardinality: "many",
	handler: ingest
});

app.http("devices", {
	methods: ["GET"],
	route: "devices",
	handler: getDevices
});

app.http("sensors", {
	methods: ["GET"],
	route: "devices/{deviceId}/sensors",
	handler: getSensors
});

app.http("measurements", {
	methods: ["GET"],
	route: "devices/{deviceId}/sensors/{sensorId}/measurements",
	handler: getMeasurements
});


app.http("hourly", {
	methods: ["GET"],
	route: "devices/{deviceId}/sensors/{sensorId}/hourly",
	handler: getHourly
});

app.http("trigger", {
	methods: ["GET"],
	route: "devices/{deviceId}/sensors/{sensorId}/trigger",
	handler: getTrigger
});

app.storageQueue("blob-writer", {
	queueName: "%QUEUE_BLOB_BATCH%",
	connection: "AzureWebJobsStorage",
	handler: runBlobWriter
});

app.storageQueue("timescale-writer", {
	queueName: "%QUEUE_DB_WRITE%",
	connection: "AzureWebJobsStorage",
	handler: runTimescaleWriter
});
