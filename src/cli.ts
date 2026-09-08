import { config } from "./config.js";
import { closePool, getPool, withTransaction } from "./db/pool.js";
import { appliedMigrations, migrate, pendingMigrations, resetDatabase } from "./db/migrate.js";
import { verifyLedger } from "./ledger/verify.js";

/**
 * The operator's tool: migrate, inspect, verify.
 *
 * `verify` is the one worth having. It re-derives every balance from the
 * journal and reports any disagreement, which turns a cache drift into an
 * alert instead of an accounting mystery discovered a month later.
 */
async function main(): Promise<void> {
  const command = process.argv[2];
  config();

  switch (command) {
    case "migrate": {
      const ran = await migrate((msg) => console.log(msg));
      if (ran.length > 0) console.log(`applied ${ran.length} migration(s)`);
      break;
    }

    case "status": {
      const applied = await appliedMigrations();
      const pending = await pendingMigrations();
      console.log(`applied: ${applied.length ? applied.join(", ") : "(none)"}`);
      console.log(`pending: ${pending.length ? pending.join(", ") : "(none)"}`);
      break;
    }

    case "reset": {
      await resetDatabase();
      console.log("database reset and migrated");
      break;
    }

    case "verify": {
      const report = await withTransaction((db) => verifyLedger(db));
      console.log(`accounts:  ${report.accountsChecked}`);
      console.log(`transfers: ${report.transfersChecked}`);
      console.log(`took:      ${report.durationMs}ms`);
      if (report.ok) {
        console.log("\nledger is consistent");
      } else {
        console.log(`\n${report.problems.length} problem(s):`);
        for (const p of report.problems) {
          console.log(`  [${p.check}] ${p.subject}: ${p.detail}`);
        }
        process.exitCode = 1;
      }
      break;
    }

    default:
      console.log("usage: kori <migrate|status|reset|verify>");
      process.exitCode = 2;
  }

  await closePool();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closePool().catch(() => {});
  process.exit(1);
});
