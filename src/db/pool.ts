import pg from "pg";

import { config } from "../config.js";

const { Pool, types } = pg;

/**
 * PostgreSQL `bigint` arrives as a string by default, because node-postgres
 * will not silently narrow a 64-bit integer into a JS double.
 *
 * That default is right, and here it is made stricter: OID 20 (int8) is parsed
 * into a real `bigint`. Every balance and every entry amount in kori is an
 * int8, so without this each one would arrive as a string and be one careless
 * `Number()` away from losing precision above 2^53.
 */
types.setTypeParser(20, (value: string) => BigInt(value));

/** `numeric` stays a string. Nothing in kori uses it, and a double would be wrong. */
types.setTypeParser(1700, (value: string) => value);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = config();
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      // A connection that has been idle this long is probably not coming back;
      // returning it keeps the server's connection count honest.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // An idle client can fail for reasons that have nothing to do with any
    // request -- the database restarting, a network blip. Without a handler,
    // node treats the error event as unhandled and takes the process down.
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("postgres idle client error:", err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** The subset of a pg client that the data layer needs. */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Run a function inside a database transaction.
 *
 * Every caller receives the *same* client, which is the point: two queries on
 * two different pooled connections are two transactions, however tidy the code
 * looks. Passing the client explicitly rather than hiding it in async-local
 * state makes it impossible to accidentally escape the transaction.
 */
export async function withTransaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // The rollback is best-effort. If the connection itself has failed, the
    // rollback will fail too, and reporting *that* instead of the original
    // error would hide the actual cause.
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignored on purpose; the original error is the one worth propagating
    }
    throw error;
  } finally {
    client.release();
  }
}

/** A query outside any transaction, for reads that do not need one. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(text, values as unknown[]);
}

/**
 * PostgreSQL error codes that the application distinguishes.
 *
 * Matching on the code rather than on the message text is what keeps this
 * working across locales and PostgreSQL versions.
 */
export const PgError = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  RESTRICT_VIOLATION: "23001",
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK_DETECTED: "40P01",
} as const;

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** The constraint that failed, when a PostgreSQL error names one. */
export function pgConstraint(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "constraint" in error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : undefined;
  }
  return undefined;
}
