export type ValueType = "number" | "boolean" | "string" | "enum";

export interface TelemetryMessage {
    schemaVersion: 1;

    deviceId: string;
    sensorId: string;

    ts: string;        // Ex. 2026-01-23T12:34:56.789Z
    seq: number;

    type: string;      // temperature, humidity, cpu_temp, ...
    valueType: ValueType;
    value: number | boolean | string;

    unit?: string;
    location?: string;
}