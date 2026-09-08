import type { Db } from "../db/pool.js";

/**
 * Verification: re-derive the ledger from the journal and check it against
 * what the ledger says about itself.
 *
 * The cached balance on an account is an optimisation, and every optimisation
 * is a chance for two things that should agree to stop agreeing. These checks
 * are how that is detected rather than discovered months later during a
 * reconciliation.
 *
 * They are cheap enough to run on a schedule and are exposed through the CLI
 * and a health endpoint, so a drift becomes an alert rather than an accounting
 * mystery.
 */

export interface VerificationProblem {
  check: string;
  detail: string;
  subject: string;
}

export interface VerificationReport {
  ok: boolean;
  accountsChecked: number;
  transfersChecked: number;
  problems: VerificationProblem[];
  durationMs: number;
}

export async function verifyLedger(db: Db): Promise<VerificationReport> {
  const started = Date.now();
  const problems: VerificationProblem[] = [];

  // 1. Every account's cached balance equals the sum of its entries.
  //
  // This is the one that catches a bug in posting: if an entry was written
  // without the matching balance update, or vice versa, the two diverge and
  // every subsequent read of that account is wrong.
  // Every SUM below is cast back to bigint. PostgreSQL widens SUM(bigint) to
  // numeric to guarantee it cannot overflow, and the pool deliberately parses
  // numeric as a string rather than risk a double -- so without the cast these
  // arrive as text and the arithmetic below silently concatenates.
  const { rows: driftRows } = await db.query<{
    handle: string;
    cached: bigint;
    derived: bigint;
  }>(
    `SELECT a.handle,
            a.balance                       AS cached,
            COALESCE(SUM(e.amount), 0)::bigint AS derived
       FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.id
      GROUP BY a.id, a.handle, a.balance
     HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
  );

  for (const row of driftRows) {
    problems.push({
      check: "balance_matches_journal",
      subject: row.handle,
      detail:
        `cached balance is ${row.cached} but the entries sum to ${row.derived} ` +
        `(off by ${row.cached - row.derived})`,
    });
  }

  // 2. Every transfer's entries sum to zero.
  //
  // The database enforces this with a deferred constraint trigger, so a failure
  // here would mean the trigger was dropped or bypassed. Checking anyway is the
  // point of a verification pass: it does not assume the mechanism that was
  // supposed to prevent the problem is still in place.
  const { rows: unbalanced } = await db.query<{ transfer_id: string; imbalance: bigint }>(
    `SELECT transfer_id, SUM(amount)::bigint AS imbalance
       FROM entries
      GROUP BY transfer_id
     HAVING SUM(amount) <> 0`,
  );

  for (const row of unbalanced) {
    problems.push({
      check: "transfer_balances",
      subject: row.transfer_id,
      detail: `entries sum to ${row.imbalance} instead of 0`,
    });
  }

  // 3. Every transfer has at least two entries.
  const { rows: singleSided } = await db.query<{ transfer_id: string; n: string }>(
    `SELECT transfer_id, count(*)::text AS n
       FROM entries
      GROUP BY transfer_id
     HAVING count(*) < 2`,
  );

  for (const row of singleSided) {
    problems.push({
      check: "transfer_is_double_entry",
      subject: row.transfer_id,
      detail: `has ${row.n} entr(y/ies); double-entry requires at least two`,
    });
  }

  // 4. No account is negative unless it is allowed to be.
  const { rows: overdrawn } = await db.query<{ handle: string; balance: bigint }>(
    "SELECT handle, balance FROM accounts WHERE balance < 0 AND NOT allow_negative",
  );

  for (const row of overdrawn) {
    problems.push({
      check: "no_unauthorised_overdraft",
      subject: row.handle,
      detail: `balance is ${row.balance} and the account does not allow negatives`,
    });
  }

  // 5. The whole ledger sums to zero, per currency.
  //
  // The strongest check available. Money is never created or destroyed by a
  // double-entry system, only moved, so the sum of every entry in a currency
  // must be exactly zero. If it is not, something wrote to the journal without
  // going through postTransfer.
  const { rows: worldwide } = await db.query<{ currency: string; total: bigint }>(
    `SELECT currency, SUM(amount)::bigint AS total
       FROM entries
      GROUP BY currency
     HAVING SUM(amount) <> 0`,
  );

  for (const row of worldwide) {
    problems.push({
      check: "conservation_of_money",
      subject: row.currency,
      detail: `all ${row.currency.trim()} entries sum to ${row.total} instead of 0`,
    });
  }

  // 6. An entry's currency matches its account's.
  const { rows: mismatched } = await db.query<{ id: string; handle: string }>(
    `SELECT e.id, a.handle
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
      WHERE e.currency <> a.currency`,
  );

  for (const row of mismatched) {
    problems.push({
      check: "entry_currency_matches_account",
      subject: `entry ${row.id}`,
      detail: `entry currency differs from account ${row.handle}`,
    });
  }

  // Sequential, not Promise.all. `db` is one connection, and a connection runs
  // one query at a time -- issuing two together does not parallelise anything,
  // it queues them behind a deprecation warning and will throw outright in
  // pg@9. Parallelism here would need two connections, and two connections
  // would mean two transactions, which is the opposite of what a consistency
  // check wants.
  const accountCount = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM accounts",
  );
  const transferCount = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM transfers",
  );

  return {
    ok: problems.length === 0,
    accountsChecked: Number(accountCount.rows[0]?.n ?? 0),
    transfersChecked: Number(transferCount.rows[0]?.n ?? 0),
    problems,
    durationMs: Date.now() - started,
  };
}
