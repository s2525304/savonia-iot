import type { SensorConfig } from "../lib/config";
import type { SensorModule } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function nowPhase(): number {
	const now = Date.now();
	return (now % DAY_MS) / DAY_MS; // 0..1
}

function sinusoidalTemp(base: number, amplitude: number): number {
	// phase 0 = midnight, peak at ~14:00
	const phaseShift = -0.25; // move peak to daytime
	const phase = 2 * Math.PI * (nowPhase() + phaseShift);
	return base + amplitude * Math.sin(phase);
}

function jitter(max: number): number {
	return (Math.random() * 2 - 1) * max;
}

const RandomTempSensor: SensorModule = {
	type: "random_temp",

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
			throw new Error("random_temp sensor must use valueType 'number'");
		}
	},

	async read(): Promise<{ valueType: "number"; value: number }> {
		// base indoor temperature ~21C, daily swing ~2C
		const base = 21.0;
		const amplitude = 3.0;

		const temp = sinusoidalTemp(base, amplitude) + jitter(0.1);

		// round to 2 decimals to look realistic
		return {
			valueType: "number",
			value: Math.round(temp * 100) / 100
		};
	}
};

export default RandomTempSensor;
