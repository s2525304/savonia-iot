import type { SensorModule } from "./types";
import RandomTempSensor from "./random-temp";
import PiCpuTempSensor from "./pi-cpu-temp";
import RuuviTempSensor from "./ruuvi-temp";
import Dht22Sensor from "./dht22";

const registry = new Map<string, SensorModule>([
	[RandomTempSensor.type, RandomTempSensor],
	[PiCpuTempSensor.type, PiCpuTempSensor],
	[RuuviTempSensor.type, RuuviTempSensor],
	[Dht22Sensor.type, Dht22Sensor]
]);

/**
 * Resolve a sensor module by sensor type.
 * Throws if the type is unsupported.
 */
export function getSensorModule(type: string): SensorModule {
	const mod = registry.get(type);
	if (!mod) {
		throw new Error(`Unsupported sensor type '${type}'`);
	}
	return mod;
}