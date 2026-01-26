

import fs from "node:fs/promises";

import type { SensorConfig } from "../lib/config";
import type { SensorModule } from "./types";

// Default Linux sysfs path for CPU temperature on Raspberry Pi.
// Value is typically an integer in millidegrees Celsius, e.g. "45321\n".
const DEFAULT_SYSFS_TEMP_PATH = "/sys/class/thermal/thermal_zone0/temp";

async function readCpuTempC(sysfsPath: string): Promise<number> {
	const raw = (await fs.readFile(sysfsPath, "utf8")).trim();
	const milli = Number(raw);
	if (!Number.isFinite(milli)) {
		throw new Error(`Invalid CPU temperature value '${raw}' from ${sysfsPath}`);
	}
	// Convert millidegrees Celsius -> Celsius
	return milli / 1000;
}

const PiCpuTempSensor: SensorModule = {
	type: "pi_cpu_temp",

	defaults(config: SensorConfig): void {
		if (!config.valueType) {
			config.valueType = "number";
		}
		if (!config.unit) {
			config.unit = "C";
		}
	},

	validate(config: SensorConfig): void {
		if (config.valueType !== "number") {
			throw new Error("pi_cpu_temp sensor must use valueType 'number'");
		}
	},

	async read(config?: SensorConfig): Promise<{ valueType: "number"; value: number }> {
		const sysfsPath = DEFAULT_SYSFS_TEMP_PATH;
		const tempC = await readCpuTempC(sysfsPath);

		// Round to 2 decimals to look realistic/consistent with other sensors
		const rounded = Math.round(tempC * 100) / 100;
		return {
			valueType: "number",
			value: rounded
		};
	}
};

export default PiCpuTempSensor;