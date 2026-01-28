import type { InvocationContext } from "@azure/functions";

export interface Logger {
	info(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

export function createLogger(context: InvocationContext): Logger {
	const logLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();

	function shouldLog(level: "debug" | "info" | "error"): boolean {
		if (level === "error") return true;
		if (logLevel === "debug") return true;
		return logLevel === "info" && level === "info";
	}

	function format(message: string, args: unknown[]): string {
		if (!args.length) return message;
		return `${message} ${args.map(a => JSON.stringify(a)).join(" ")}`;
	}

	return {
		info(message: string, ...args: unknown[]): void {
			if (shouldLog("info")) {
				context.log(format(message, args));
			}
		},

		debug(message: string, ...args: unknown[]): void {
			if (shouldLog("debug")) {
				context.log(format(message, args));
			}
		},

		error(message: string, ...args: unknown[]): void {
			// Errors are always logged. InvocationContext.log is typed as a function,
			// so we log with a clear prefix. If context has a dedicated error logger
			// at runtime, use it.
			const line = `[ERROR] ${format(message, args)}`;
			const anyCtx = context as unknown as { error?: (...a: unknown[]) => void };
			if (typeof anyCtx.error === "function") {
				anyCtx.error(line);
				return;
			}
			context.log(line);
		}
	};
}