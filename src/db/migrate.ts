import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPool } from "./pool.js";

/**
 * Migrations: forward-only, applied in filename order, each in its own
 * transaction.
 *
 * There are no `down` migrations, which is a deliberate omission rather than
 * an unfinished feature. A rollback that has to undo a destructive change
 * cannot restore the data it dropped, so the `down` script is either trivial
 * or a lie. Recovering from a bad migration means restoring a backup or
 * writing a new forward migration, and pretending otherwise gives false
 * confidence at exactly the wrong moment.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface AppliedMigration {
  name: string;
  applied_at: Date;
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function appliedMigrations(): Promise<string[]> {
  await ensureMigrationsTable();
  const { rows } = await getPool().query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  return rows.map((row) => row.name);
}

export async function pendingMigrations(): Promise<string[]> {
  const applied = new Set(await appliedMigrations());
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return files.filter((file) => !applied.has(file));
}

/**
 * Apply every pending migration.
 *
 * Each runs inside its own transaction together with the row recording it, so
 * a migration and the fact that it was applied commit or fail as one. A
 * migration that half-applied and was recorded anyway is the failure mode this
 * prevents, and it is the one that ruins an afternoon.
 */
export async function migrate(log: (msg: string) => void = () => {}): Promise<string[]> {
  const pending = await pendingMigrations();
  if (pending.length === 0) {
    log("no pending migrations");
    return [];
  }

  const pool = getPool();
  const ran: string[] = [];

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log(`applied ${file}`);
      ran.push(file);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // the original error is the one that matters
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${file} failed: ${message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return ran;
}

/**
 * Drop everything and re-migrate. Test-only, and it refuses to run against a
 * database whose name does not look like a test database -- the cost of being
 * wrong here is someone's data.
 */
export async function resetDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/test|kori/i.test(url)) {
    throw new Error(`refusing to reset a database that does not look like a test one: ${url}`);
  }

  await getPool().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
}
