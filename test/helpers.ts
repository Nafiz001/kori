import { randomUUID } from "node:crypto";

import { migrate } from "../src/db/migrate.js";
import { type Db, getPool, withTransaction } from "../src/db/pool.js";
import { createAccount, type AccountKind } from "../src/ledger/ledger.js";
import { type CurrencyCode, parseAmount } from "../src/money/money.js";

/**
 * Test helpers.
 *
 * Every test gets accounts with unique handles rather than a truncated
 * database, so that the concurrency tests can run against a database that
 * already holds data. A test that only passes on an empty table is not testing
 * the thing it claims to.
 */

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
}

/** A handle no other test will use. */
export function uniqueHandle(prefix: string): string {
  return `${prefix}:${randomUUID().slice(0, 8)}`;
}

export interface TestAccountOptions {
  currency?: CurrencyCode;
  kind?: AccountKind;
  allowNegative?: boolean;
  /** Opening balance as a decimal string, funded from a system account. */
  balance?: string;
}

/**
 * Create an account, optionally funded.
 *
 * Funding goes through a real transfer from a system account that is allowed
 * to go negative, rather than by writing a balance directly. Seeding a balance
 * behind the ledger's back would leave the books unbalanced, and every
 * verification test would then fail for a reason that has nothing to do with
 * the code under test.
 */
export async function makeAccount(
  handle: string,
  options: TestAccountOptions = {},
): Promise<string> {
  const currency = options.currency ?? "BDT";

  await withTransaction(async (db) => {
    await createAccount(db, {
      handle,
      name: handle,
      currency,
      kind: options.kind ?? "liability",
      ...(options.allowNegative !== undefined ? { allowNegative: options.allowNegative } : {}),
    });
  });

  if (options.balance && options.balance !== "0") {
    const source = await systemAccount(currency);
    const { postTransfer } = await import("../src/ledger/ledger.js");
    await withTransaction(async (db) => {
      await postTransfer(db, {
        kind: "deposit",
        lines: [
          { accountHandle: source, amount: parseAmount(currency, `-${options.balance}`) },
          { accountHandle: handle, amount: parseAmount(currency, options.balance!) },
        ],
      });
    });
  }

  return handle;
}

const systemAccounts = new Map<string, string>();

/** A shared source of funds, allowed to go negative because it is the mint. */
export async function systemAccount(currency: CurrencyCode): Promise<string> {
  const existing = systemAccounts.get(currency);
  if (existing) return existing;

  const handle = `system:mint:${currency}`;
  await withTransaction(async (db) => {
    const { getAccountByHandle } = await import("../src/ledger/ledger.js");
    if (await getAccountByHandle(db, handle)) return;
    await createAccount(db, {
      handle,
      name: `${currency} mint`,
      currency,
      kind: "equity",
      allowNegative: true,
    });
  });

  systemAccounts.set(currency, handle);
  return handle;
}

export async function balanceOf(handle: string): Promise<bigint> {
  const { rows } = await getPool().query<{ balance: bigint }>(
    "SELECT balance FROM accounts WHERE handle = $1",
    [handle],
  );
  if (!rows[0]) throw new Error(`no account ${handle}`);
  return rows[0].balance;
}

/** Re-derive a balance from the journal, ignoring the cached column. */
export async function derivedBalanceOf(handle: string): Promise<bigint> {
  const { rows } = await getPool().query<{ total: bigint }>(
    `SELECT COALESCE(SUM(e.amount), 0)::bigint AS total
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
      WHERE a.handle = $1`,
    [handle],
  );
  return rows[0]?.total ?? 0n;
}

export async function countEntries(handle: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM entries e JOIN accounts a ON a.id = e.account_id
      WHERE a.handle = $1`,
    [handle],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Run a function in a transaction, swallowing the error and reporting it. */
export async function attempt<T>(
  fn: (db: Db) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await withTransaction(fn) };
  } catch (error) {
    return { ok: false, error };
  }
}
