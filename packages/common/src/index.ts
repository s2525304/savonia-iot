// Telemetry message shape (used by Raspberry + Azure)
export type { TelemetryMessage, ValueType } from "./telemetry";

// Validation schema (used mainly by Azure Functions)
export { TelemetrySchema } from "./schema";
export type { TelemetryMessage as TelemetryMessageValidated } from "./schema";
