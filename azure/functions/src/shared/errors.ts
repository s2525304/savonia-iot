

export type ErrorCode =
	| "CONFIG_ERROR"
	| "DB_ERROR"
	| "VALIDATION_ERROR"
	| "NOT_FOUND"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "BAD_REQUEST"
	| "INTERNAL_ERROR";

export class AppError extends Error {
	public readonly code: ErrorCode;
	public readonly status: number;
	public readonly details?: unknown;

	constructor(params: { code: ErrorCode; message: string; status: number; details?: unknown; cause?: unknown }) {
		super(params.message);
		this.name = "AppError";
		this.code = params.code;
		this.status = params.status;
		this.details = params.details;

		// Node 16+ supports Error.cause
		if (params.cause !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this as any).cause = params.cause;
		}
	}
}

export function asAppError(err: unknown): AppError {
	if (err instanceof AppError) {
		return err;
	}

	if (err instanceof Error) {
		return new AppError({
			code: "INTERNAL_ERROR",
			status: 500,
			message: err.message,
			cause: err
		});
	}

	return new AppError({
		code: "INTERNAL_ERROR",
		status: 500,
		message: "Unknown error",
		details: err
	});
}

export function configError(message: string, details?: unknown): AppError {
	return new AppError({
		code: "CONFIG_ERROR",
		status: 500,
		message,
		details
	});
}

export function dbError(message: string, details?: unknown, cause?: unknown): AppError {
	return new AppError({
		code: "DB_ERROR",
		status: 500,
		message,
		details,
		cause
	});
}

export function badRequest(message: string, details?: unknown): AppError {
	return new AppError({
		code: "BAD_REQUEST",
		status: 400,
		message,
		details
	});
}

export function unauthorized(message = "Unauthorized"): AppError {
	return new AppError({
		code: "UNAUTHORIZED",
		status: 401,
		message
	});
}

export function forbidden(message = "Forbidden"): AppError {
	return new AppError({
		code: "FORBIDDEN",
		status: 403,
		message
	});
}

export function notFound(message = "Not found"): AppError {
	return new AppError({
		code: "NOT_FOUND",
		status: 404,
		message
	});
}

export function toSafeErrorResponse(err: unknown): { status: number; body: { error: { code: ErrorCode; message: string } } } {
	const e = asAppError(err);

	// For now we keep the response minimal (no internal details)
	return {
		status: e.status,
		body: {
			error: {
				code: e.code,
				message: e.message
			}
		}
	};
}