import type { SensorConfig } from "../lib/config";
import type { SensorModule, SensorReaderResult } from "./types";

/**
 * node-dht-sensor native addon (CommonJS)
 */
type NodeDhtSensor = {
    read: (
        type: number,
        gpio: number,
        cb: (err: unknown, temperature: number, humidity: number) => void
    ) => void;
};

const DHT22_TYPE = 22;

/**
 * DHT22 / AM2302 sensor using node-dht-sensor.
 *
 * Config:
 * - gpio: BCM GPIO number (e.g. 17)
 * - unit:
 *     "C"  -> temperature
 *     "%"  -> humidity
 */
const Dht22Sensor: SensorModule = {
    type: "dht22",

    validate(config: SensorConfig): void {
        if (!Number.isInteger(config.gpio) || (config.gpio ?? 0) <= 0) {
            throw new Error("dht22: gpio must be a valid BCM pin number");
        }

        const unit = (config.unit ?? "").trim();
        if (unit !== "C" && unit !== "%") {
            throw new Error('dht22: unit must be "C" (temperature) or "%" (humidity)');
        }

        if (config.valueType && config.valueType !== "number") {
            throw new Error('dht22: valueType must be "number"');
        }
    },

    async read(config: SensorConfig): Promise<SensorReaderResult> {
        const gpio = config.gpio as number;
        const want: "temperature" | "humidity" =
            (config.unit ?? "C") === "%" ? "humidity" : "temperature";

        const lib = await loadNodeDhtSensor();

        const { temperature, humidity } = await readWithRetries(lib, gpio);

        const value = want === "temperature" ? temperature : humidity;

        return {
            valueType: "number",
            value
        };
    }
};

export default Dht22Sensor;

/* ================= helpers ================= */

async function loadNodeDhtSensor(): Promise<NodeDhtSensor> {
    // node-dht-sensor is CommonJS; ESM import may expose default
    const mod = (await import("node-dht-sensor")) as any;
    return (mod?.default ?? mod) as NodeDhtSensor;
}

async function readWithRetries(
    lib: NodeDhtSensor,
    gpio: number
): Promise<{ temperature: number; humidity: number }> {
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await new Promise<{ temperature: number; humidity: number }>(
                (resolve, reject) => {
                    lib.read(DHT22_TYPE, gpio, (err, temperature, humidity) => {
                        if (err) return reject(err);
                        resolve({ temperature, humidity });
                    });
                }
            );

            if (!Number.isFinite(res.temperature) || !Number.isFinite(res.humidity)) {
                throw new Error(
                    `non-finite values (t=${res.temperature}, h=${res.humidity})`
                );
            }

            return res;
        } catch (e) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    throw lastErr instanceof Error
        ? lastErr
        : new Error("node-dht-sensor read failed");
}