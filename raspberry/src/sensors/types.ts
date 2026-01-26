import type { SensorConfig, ValueType } from "../lib/config";

export interface SensorReaderResult {
	valueType: ValueType;
	value: number | boolean | string;
}

/**
 * SensorModule defines the contract that all sensor implementations must follow.
 * - type: unique sensor type identifier used in config.json
 * - defaults: optional hook to apply sensor-specific default values
 * - validate: validates sensor-specific configuration
 * - read: reads a single sensor value (one-shot)
 */
export interface SensorModule {
	readonly type: string;

	/**
	 * Apply sensor-specific default values (optional).
	 * This allows keeping config.ts sensor-agnostic.
	 */
	defaults?(config: SensorConfig): void;

	/**
	 * Validate sensor-specific configuration.
	 * Should throw an Error on invalid configuration.
	 */
	validate(config: SensorConfig): void;

	/**
	 * Read one value from the sensor.
	 */
	read(config: SensorConfig): Promise<SensorReaderResult>;
}
