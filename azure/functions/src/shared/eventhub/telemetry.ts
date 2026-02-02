import { z } from "zod";

export const TelemetrySchema = z.object({
    schemaVersion: z.literal(1),
    deviceId: z.string(),
    sensorId: z.string(),
    ts: z.string(),
    seq: z.number().int().nonnegative(),
    type: z.string(),
    valueType: z.enum(["number", "boolean", "string", "enum"]),
    value: z.union([z.number(), z.boolean(), z.string()]),
    unit: z.string().optional(),
    location: z.string().optional()
});

export type TelemetryMessage = z.infer<typeof TelemetrySchema>;