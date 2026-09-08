import { config } from "./config.js";
import { closePool, getPool, withTransaction } from "./db/pool.js";
import { appliedMigrations, migrate, pendingMigrations, resetDatabase } from "./db/migrate.js";
import { verifyLedger } from "./ledger/verify.js";
import { generateApiKey, hashSecret } from "./http/middleware.js";
import { sweepExpired } from "./idempotency/store.js";
import { randomUUID } from "node:crypto";

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

    case "apikey": {
      const name = process.argv[3];
      if (!name) {
        console.log("usage: kori apikey <name> [scope ...]");
        process.exitCode = 2;
        break;
      }
      const scopes = process.argv.slice(4);
      const { key, prefix, secret } = generateApiKey();

      await withTransaction(async (db) => {
        await db.query(
          `INSERT INTO api_keys (id, name, prefix, secret_hash, scopes)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), name, prefix, await hashSecret(secret), scopes.length ? scopes : ["*"]],
        );
      });

      // Shown once and never again. Only the Argon2 hash is stored, so there is
      // no way to recover this later -- which is the property that makes a
      // leaked database useless to an attacker.
      console.log(`name:   ${name}`);
      console.log(`scopes: ${(scopes.length ? scopes : ["*"]).join(", ")}`);
      console.log(`key:    ${key}`);
      console.log("");
      console.log("This is the only time the key is shown. Store it now.");
      break;
    }

    case "sweep": {
      const removed = await withTransaction((db) => sweepExpired(db));
      console.log(`removed ${removed} expired idempotency key(s)`);
      break;
    }

    default:
      console.log("usage: kori <migrate|status|reset|verify|apikey|sweep>");
      process.exitCode = 2;
  }

  await closePool();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closePool().catch(() => {});
  process.exit(1);
});
