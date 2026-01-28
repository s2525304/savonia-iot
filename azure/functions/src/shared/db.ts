import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { loadConfig } from "./config";
import { dbError } from "./errors";

let pool: Pool | null = null;

function createPool(): Pool {
	const cfg = loadConfig();

	return new Pool({
		connectionString: cfg.timescale.connectionString,
		ssl: {
			rejectUnauthorized: false
		},
		max: 5,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 10_000
	});
}

function getPool(): Pool {
	if (!pool) {
		pool = createPool();
	}
	return pool;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await getPool().connect();
	try {
		return await fn(client);
	} catch (err) {
		throw dbError("Database operation failed", undefined, err);
	} finally {
		client.release();
	}
}

export async function query<T extends QueryResultRow = QueryResultRow>(
	sql: string,
	params: readonly unknown[] = []
): Promise<QueryResult<T>> {
	// pg typings expect a mutable array (any[]). Convert readonly params to a new array.
	const values = Array.from(params) as unknown[];
	try {
		return await getPool().query<T>(sql, values as any[]);
	} catch (err) {
		throw dbError("Database query failed", { sql, params }, err);
	}
}

export async function healthCheck(): Promise<void> {
	await query("SELECT 1");
}