// sensors/ruuvi-temp.ts
import type { SensorConfig } from "../lib/config";
import type { SensorModule } from "./types";

// NOTE: This implementation expects a Noble-compatible BLE library.
// Common choice: @abandonware/noble
// @abandonware/noble is CommonJS (export = noble). Use TS-compatible require-import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import noble = require("@abandonware/noble");

// The published typings sometimes expose `_state` but not the `state` getter.
// Use a tiny accessor to stay compatible with both.
function nobleState(): string {
	const n = noble as any;
	return String(n.state ?? n._state ?? "unknown");
}

type ParsedRuuvi = {
    tempC: number;
};

// RuuviTag manufacturer ID (Apple BLE manufacturer section uses company IDs;
// Ruuvi Innovations is 0x0499)
const RUUVI_COMPANY_ID = 0x0499;

// Parse manufacturer data for RuuviTag data formats 3 and 5.
// Returns null if not recognized or not parseable.
function parseRuuviManufacturerData(data: Buffer): ParsedRuuvi | null {
    // manufacturerData layout:
    // [0..1] company id (LE)
    // [2]    data format
    if (!data || data.length < 3) return null;

    const companyId = data.readUInt16LE(0);
    if (companyId !== RUUVI_COMPANY_ID) return null;

    const format = data.readUInt8(2);

    // Data Format 3: https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-3
    // 0: company id (2 bytes LE)
    // 2: format = 0x03
    // 3: humidity (uint8, 0.5 %)
    // 4-5: temperature (int16 BE, 0.005 C)
    // ...
    if (format === 0x03) {
        if (data.length < 6) return null;
        const tempRaw = data.readInt16BE(4);
        const tempC = tempRaw * 0.005;
        return { tempC };
    }

    // Data Format 5: https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5
    // 0: company id (2 bytes LE)
    // 2: format = 0x05
    // 3-4: temperature (int16 BE, 0.005 C)
    // ...
    if (format === 0x05) {
        if (data.length < 5) return null;
        const tempRaw = data.readInt16BE(3);
        const tempC = tempRaw * 0.005;
        return { tempC };
    }

    return null;
}

function normalizeAddress(addr?: string | null): string | null {
    if (!addr) return null;
    const s = String(addr).trim().toLowerCase();
    if (!s) return null;
    return s;
}

async function readRuuviTempOnce(targetAddress?: string): Promise<number> {
    const wanted = normalizeAddress(targetAddress);

    return await new Promise<number>((resolve, reject) => {
        let done = false;
		let timeout: NodeJS.Timeout | undefined;

        const finishOk = async (tempC: number) => {
            if (done) return;
            done = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
            await cleanup();
            resolve(tempC);
        };

        const finishErr = async (err: unknown) => {
            if (done) return;
            done = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
            await cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
        };

        const cleanup = async () => {
            try {
                try {
                    noble.removeAllListeners("discover");
                    noble.removeAllListeners("stateChange");
                } catch {
                    // ignore
                }

                try {
                    noble.stopScanning();
                } catch {
                    // ignore
                }

                // Some stacks keep handles open; give them a tick to settle.
                await new Promise<void>(r => setTimeout(r, 50));
            } catch {
                // ignore
            }
        };

        const onDiscover = (peripheral: any) => {
            try {
                if (!peripheral) return;

                const addr = normalizeAddress(peripheral.address);
                if (wanted && addr && addr !== wanted) return;

                const mfg: Buffer | undefined = peripheral.advertisement?.manufacturerData;
                if (!mfg || !Buffer.isBuffer(mfg)) return;

                const parsed = parseRuuviManufacturerData(mfg);
                if (!parsed) return;

                finishOk(parsed.tempC).catch(() => {
                    // If cleanup fails, still resolve.
                    resolve(parsed.tempC);
                });
            } catch (err) {
                finishErr(err).catch(() => {
                    reject(err instanceof Error ? err : new Error(String(err)));
                });
            }
        };

        const startScan = async () => {
            try {
                noble.on("discover", onDiscover);

                // allowDuplicates=true to get quick reads if needed.
                // Service UUIDs filter is not used because Ruuvi uses manufacturer data.
                noble.startScanning([], true);
            } catch (err) {
                await finishErr(err);
            }
        };

        // Hard timeout so the process doesn't hang forever if no tag is found.
        timeout = setTimeout(() => {
            finishErr(new Error("Timed out waiting for RuuviTag advertisement")).catch(() => {
                reject(new Error("Timed out waiting for RuuviTag advertisement"));
            });
        }, 15000);

        // BLE adapter state handling
        noble.on("stateChange", (state: string) => {
            if (state === "poweredOn") {
                startScan().catch(err => finishErr(err));
                return;
            }
            // If the adapter isn't usable, fail fast.
            if (state === "unsupported" || state === "unauthorized" || state === "poweredOff") {
                finishErr(new Error(`BLE adapter state: ${state}`)).catch(() => {
                    reject(new Error(`BLE adapter state: ${state}`));
                });
            }
        });

        // If noble is already powered on, kick off immediately.
        if (nobleState() === "poweredOn") {
            startScan().catch(err => finishErr(err));
        }
    });
}

const RuuviTempSensor: SensorModule = {
    type: "ruuvi_temp",

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
            throw new Error("ruuvi_temp sensor must use valueType 'number'");
        }
        // Optional: config.address (BLE MAC) can be used to target a specific tag.
        // If omitted, the first RuuviTag advertisement seen is used.
    },

    async read(config?: SensorConfig): Promise<{ valueType: "number"; value: number }> {
        // Optional: select a specific RuuviTag by BLE address
        // (You can standardize the property name to whatever your SensorConfig supports.)
        const address = (config as any)?.address ?? (config as any)?.mac ?? undefined;

        const tempC = await readRuuviTempOnce(address ? String(address) : undefined);

        const rounded = Math.round(tempC * 100) / 100;


        return {
            valueType: "number",
            value: rounded
        };
    }
};

export default RuuviTempSensor;