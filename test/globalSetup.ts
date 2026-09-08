import { closePool } from "../src/db/pool.js";
import { resetDatabase } from "../src/db/migrate.js";

/**
 * Drop and re-migrate once, before the whole run.
 *
 * The integration tests share one database, and several of them assert about
 * the ledger *as a whole* -- that every account's balance matches the journal,
 * that all entries sum to zero. Those checks are only meaningful against a
 * known starting point: a single row left behind by an earlier aborted run
 * makes them fail for a reason that has nothing to do with the code, which is
 * the worst kind of test failure to debug.
 */
export async function setup(): Promise<void> {
  await resetDatabase();
  await closePool();
}
