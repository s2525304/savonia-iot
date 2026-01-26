import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

export interface LoggerOptions {
	logDir: string;
	serviceName: string;
	level?: string;
	console?: boolean;
	rotate?: boolean;
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function getLevel(level?: string): string {
	return (level ?? process.env.LOG_LEVEL ?? "info").toLowerCase();
}

export function createLogger(opts: LoggerOptions): winston.Logger {
	const level = getLevel(opts.level);
	ensureDir(opts.logDir);

	const baseFormat = winston.format.combine(
		winston.format.timestamp(),
		winston.format.errors({ stack: true }),
		winston.format.splat(),
		winston.format.printf(info => {
			const ts = info.timestamp as string;
			const lvl = info.level;
			const msg = info.message;
			const svc = opts.serviceName;
			const meta = info.stack ? `\n${info.stack}` : "";
			return `${ts} [${svc}] ${lvl}: ${msg}${meta}`;
		})
	);

	const transports: winston.transport[] = [];

	// Console logs (useful during development)
	if (opts.console ?? true) {
		transports.push(
			new winston.transports.Console({
				level,
				format: baseFormat
			})
		);
	}

	// File logs
	const combinedPath = path.join(opts.logDir, `${opts.serviceName}.log`);
	const errorPath = path.join(opts.logDir, `${opts.serviceName}.error.log`);

	if (opts.rotate ?? true) {
		transports.push(
			new DailyRotateFile({
				level,
				dirname: opts.logDir,
				filename: `${opts.serviceName}.%DATE%.log`,
				datePattern: "YYYY-MM-DD",
				maxFiles: "14d",
				zippedArchive: false
			})
		);

		transports.push(
			new DailyRotateFile({
				level: "error",
				dirname: opts.logDir,
				filename: `${opts.serviceName}.error.%DATE%.log`,
				datePattern: "YYYY-MM-DD",
				maxFiles: "30d",
				zippedArchive: false
			})
		);
	} else {
		transports.push(
			new winston.transports.File({
				level,
				filename: combinedPath,
				format: baseFormat
			})
		);
		transports.push(
			new winston.transports.File({
				level: "error",
				filename: errorPath,
				format: baseFormat
			})
		);
	}

	return winston.createLogger({
		level,
		format: baseFormat,
		transports
	});
}
