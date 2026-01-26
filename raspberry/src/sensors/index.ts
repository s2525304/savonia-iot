import type { SensorModule } from "./types";
import RandomTempSensor from "./random-temp";
import PiCpuTempSensor from "./pi-cpu-temp";

const registry = new Map<string, SensorModule>([
	[RandomTempSensor.type, RandomTempSensor],
	[PiCpuTempSensor.type, PiCpuTempSensor]
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