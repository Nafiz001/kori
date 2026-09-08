import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, getPool, withTransaction } from "../src/db/pool.js";
import {
  LedgerError,
  getAccountByHandle,
  getTransfer,
  listEntries,
  postTransfer,
  reverseTransfer,
} from "../src/ledger/ledger.js";
import { verifyLedger } from "../src/ledger/verify.js";
import { parseAmount } from "../src/money/money.js";
import {
  attempt,
  balanceOf,
  countEntries,
  derivedBalanceOf,
  ensureSchema,
  makeAccount,
  systemAccount,
  uniqueHandle,
} from "./helpers.js";

const bdt = (text: string) => parseAmount("BDT", text);

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closePool();
});

describe("posting", () => {
  it("moves money between two accounts", async () => {
    const alice = await makeAccount(uniqueHandle("alice"), { balance: "100.00" });
    const bob = await makeAccount(uniqueHandle("bob"));

    await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: alice, amount: bdt("-25.50") },
          { accountHandle: bob, amount: bdt("25.50") },
        ],
      }),
    );

    expect(await balanceOf(alice)).toBe(7450n);
    expect(await balanceOf(bob)).toBe(2550n);
  });

  it("records an entry per account with the running balance", async () => {
    const alice = await makeAccount(uniqueHandle("alice"), { balance: "50.00" });
    const bob = await makeAccount(uniqueHandle("bob"));

    const transfer = await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: alice, amount: bdt("-10.00") },
          { accountHandle: bob, amount: bdt("10.00") },
        ],
      }),
    );

    expect(transfer.entries).toHaveLength(2);

    const bobEntry = transfer.entries.find((e) => e.accountHandle === bob)!;
    expect(bobEntry.amount.minor).toBe(1000n);
    expect(bobEntry.balanceAfter.minor).toBe(1000n);

    const aliceEntry = transfer.entries.find((e) => e.accountHandle === alice)!;
    expect(aliceEntry.balanceAfter.minor).toBe(4000n);
  });

  it("supports more than two lines", async () => {
    // A payment that splits into a merchant credit and a platform fee: three
    // accounts, one transfer, still balanced.
    const customer = await makeAccount(uniqueHandle("customer"), { balance: "100.00" });
    const merchant = await makeAccount(uniqueHandle("merchant"));
    const fees = await makeAccount(uniqueHandle("fees"), { kind: "revenue" });

    await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: customer, amount: bdt("-100.00") },
          { accountHandle: merchant, amount: bdt("97.50") },
          { accountHandle: fees, amount: bdt("2.50") },
        ],
      }),
    );

    expect(await balanceOf(customer)).toBe(0n);
    expect(await balanceOf(merchant)).toBe(9750n);
    expect(await balanceOf(fees)).toBe(250n);
  });

  it("nets repeated mentions of one account into a single entry", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("b"));

    const transfer = await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-30.00") },
          { accountHandle: a, amount: bdt("10.00") },
          { accountHandle: b, amount: bdt("20.00") },
        ],
      }),
    );

    // One entry for `a`, not two, and it carries the net movement.
    expect(transfer.entries).toHaveLength(2);
    expect(transfer.entries.find((e) => e.accountHandle === a)!.amount.minor).toBe(-2000n);
    expect(await balanceOf(a)).toBe(8000n);
  });
});

describe("rejections", () => {
  it("refuses an unbalanced transfer", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("b"));

    const result = await attempt((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-10.00") },
          { accountHandle: b, amount: bdt("9.00") },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error).toBeInstanceOf(LedgerError);
    expect((result as { error: LedgerError }).error.code).toBe("unbalanced");
  });

  it("refuses a single-sided posting", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });

    const result = await attempt((db) =>
      postTransfer(db, { lines: [{ accountHandle: a, amount: bdt("-10.00") }] }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("unbalanced");
  });

  it("refuses an overdraft", async () => {
    const alice = await makeAccount(uniqueHandle("alice"), { balance: "10.00" });
    const bob = await makeAccount(uniqueHandle("bob"));

    const result = await attempt((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: alice, amount: bdt("-10.01") },
          { accountHandle: bob, amount: bdt("10.01") },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("insufficient_funds");

    // And nothing moved.
    expect(await balanceOf(alice)).toBe(1000n);
    expect(await balanceOf(bob)).toBe(0n);
  });

  it("allows an account that is permitted to go negative", async () => {
    const mint = await systemAccount("BDT");
    const user = await makeAccount(uniqueHandle("user"));

    await withTransaction((db) =>
      postTransfer(db, {
        kind: "deposit",
        lines: [
          { accountHandle: mint, amount: bdt("-500.00") },
          { accountHandle: user, amount: bdt("500.00") },
        ],
      }),
    );

    expect(await balanceOf(user)).toBe(50000n);
    expect(await balanceOf(mint) < 0n).toBe(true);
  });

  it("refuses to mix currencies in one transfer", async () => {
    const taka = await makeAccount(uniqueHandle("taka"), { balance: "100.00" });
    const dollars = await makeAccount(uniqueHandle("usd"), { currency: "USD" });

    const result = await attempt((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: taka, amount: bdt("-10.00") },
          { accountHandle: dollars, amount: parseAmount("USD", "10.00") },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("currency_mismatch");
  });

  it("refuses an account whose currency differs from the transfer's", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const usd = await makeAccount(uniqueHandle("usd"), { currency: "USD" });

    const result = await attempt((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-10.00") },
          { accountHandle: usd, amount: bdt("10.00") },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("currency_mismatch");
  });

  it("refuses a frozen account", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const frozen = await makeAccount(uniqueHandle("frozen"));
    await getPool().query("UPDATE accounts SET frozen = true WHERE handle = $1", [frozen]);

    const result = await attempt((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-10.00") },
          { accountHandle: frozen, amount: bdt("10.00") },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("account_frozen");
  });

  it("refuses an unknown account", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });

    const result = await attempt((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-10.00") },
          { accountHandle: "does:not:exist", amount: bdt("10.00") },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("account_not_found");
  });

  it("refuses a duplicate reference", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("b"));
    const reference = uniqueHandle("ref");

    const lines = [
      { accountHandle: a, amount: bdt("-1.00") },
      { accountHandle: b, amount: bdt("1.00") },
    ];

    await withTransaction((db) => postTransfer(db, { lines, reference }));
    const second = await attempt((db) => postTransfer(db, { lines, reference }));

    expect(second.ok).toBe(false);
    expect((second as { error: LedgerError }).error.code).toBe("duplicate_reference");
    expect(await balanceOf(b)).toBe(100n);
  });
});

describe("the database enforces the invariants itself", () => {
  it("rejects unbalanced entries written behind the application's back", async () => {
    // The deferred constraint trigger is the safety net for a bug in
    // postTransfer, so it is tested by bypassing postTransfer entirely.
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const account = await withTransaction((db) => getAccountByHandle(db, a));

    const result = await attempt(async (db) => {
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO transfers (id, kind, currency) VALUES ($1, 'adjustment', 'BDT')",
        [id],
      );
      // Two entries that do not sum to zero.
      await db.query(
        `INSERT INTO entries (transfer_id, account_id, amount, currency, balance_after)
         VALUES ($1, $2, 100, 'BDT', 0), ($1, $2, -50, 'BDT', 0)`,
        [id, account!.id],
      );
    });

    expect(result.ok).toBe(false);
    expect(String((result as { error: Error }).error.message)).toMatch(/out of balance/i);
  });

  it("rejects a single-sided entry at commit", async () => {
    const a = await makeAccount(uniqueHandle("a"));
    const account = await withTransaction((db) => getAccountByHandle(db, a));

    const result = await attempt(async (db) => {
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO transfers (id, kind, currency) VALUES ($1, 'adjustment', 'BDT')",
        [id],
      );
      await db.query(
        `INSERT INTO entries (transfer_id, account_id, amount, currency, balance_after)
         VALUES ($1, $2, 100, 'BDT', 100)`,
        [id, account!.id],
      );
    });

    expect(result.ok).toBe(false);
    expect(String((result as { error: Error }).error.message)).toMatch(/double-entry requires/i);
  });

  it("refuses to update or delete an entry", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "10.00" });

    const update = await attempt((db) =>
      db.query(
        `UPDATE entries SET amount = 1
          WHERE account_id = (SELECT id FROM accounts WHERE handle = $1)`,
        [a],
      ),
    );
    expect(update.ok).toBe(false);
    expect(String((update as { error: Error }).error.message)).toMatch(/append-only/i);

    const del = await attempt((db) =>
      db.query(
        `DELETE FROM entries
          WHERE account_id = (SELECT id FROM accounts WHERE handle = $1)`,
        [a],
      ),
    );
    expect(del.ok).toBe(false);
    expect(String((del as { error: Error }).error.message)).toMatch(/append-only/i);
  });
});

describe("reversal", () => {
  it("posts the mirror image and leaves the original in place", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("b"));

    const original = await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-40.00") },
          { accountHandle: b, amount: bdt("40.00") },
        ],
      }),
    );

    expect(await balanceOf(b)).toBe(4000n);

    const reversal = await withTransaction((db) => reverseTransfer(db, original.id));

    expect(await balanceOf(a)).toBe(10000n);
    expect(await balanceOf(b)).toBe(0n);
    expect(reversal.kind).toBe("reversal");

    // History is added to, not rewritten: the original entries are still there.
    const stillThere = await withTransaction((db) => getTransfer(db, original.id));
    expect(stillThere!.entries).toHaveLength(2);
    expect(stillThere!.status).toBe("reversed");
    expect(await countEntries(b)).toBe(2);
  });

  it("refuses to reverse the same transfer twice", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("b"));

    const original = await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-10.00") },
          { accountHandle: b, amount: bdt("10.00") },
        ],
      }),
    );

    await withTransaction((db) => reverseTransfer(db, original.id));
    const second = await attempt((db) => reverseTransfer(db, original.id));

    expect(second.ok).toBe(false);
    expect((second as { error: LedgerError }).error.code).toBe("already_reversed");
    expect(await balanceOf(a)).toBe(10000n);
  });

  it("refuses to reverse a transfer that does not exist", async () => {
    const result = await attempt((db) => reverseTransfer(db, crypto.randomUUID()));
    expect(result.ok).toBe(false);
    expect((result as { error: LedgerError }).error.code).toBe("transfer_not_found");
  });
});

describe("statements", () => {
  it("lists an account's entries newest first with running balances", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("b"));

    for (const amount of ["10.00", "20.00", "30.00"]) {
      await withTransaction((db) =>
        postTransfer(db, {
          lines: [
            { accountHandle: a, amount: bdt(`-${amount}`) },
            { accountHandle: b, amount: bdt(amount) },
          ],
        }),
      );
    }

    const entries = await withTransaction((db) => listEntries(db, b, 10));

    expect(entries).toHaveLength(3);
    expect(entries[0]!.amount.minor).toBe(3000n);
    expect(entries[0]!.balanceAfter.minor).toBe(6000n);
    expect(entries[2]!.balanceAfter.minor).toBe(1000n);
  });
});

describe("verification", () => {
  it("reports the ledger as consistent after a workload", async () => {
    const accounts = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeAccount(uniqueHandle(`v${i}`), { balance: "100.00" })),
    );

    for (let i = 0; i < 20; i++) {
      const from = accounts[i % accounts.length]!;
      const to = accounts[(i + 1) % accounts.length]!;
      await withTransaction((db) =>
        postTransfer(db, {
          lines: [
            { accountHandle: from, amount: bdt("-1.00") },
            { accountHandle: to, amount: bdt("1.00") },
          ],
        }),
      );
    }

    const report = await withTransaction((db) => verifyLedger(db));
    if (!report.ok) console.error(report.problems);
    expect(report.ok).toBe(true);
  });

  it("detects a drifted cached balance", async () => {
    // Corrupt the cache deliberately and confirm verification notices. A check
    // that has never been seen to fail is not known to work.
    const a = await makeAccount(uniqueHandle("drift"), { balance: "100.00" });
    await getPool().query("UPDATE accounts SET balance = balance + 1 WHERE handle = $1", [a]);

    try {
      const report = await withTransaction((db) => verifyLedger(db));

      expect(report.ok).toBe(false);
      expect(
        report.problems.some((p) => p.subject === a && p.check === "balance_matches_journal"),
      ).toBe(true);
    } finally {
      // Restore in a finally. This test deliberately corrupts shared state, so
      // if an assertion above throws, every later test that checks the ledger
      // as a whole would fail for a reason that is nothing to do with them.
      await getPool().query("UPDATE accounts SET balance = balance - 1 WHERE handle = $1", [a]);
    }

    const after = await withTransaction((db) => verifyLedger(db));
    expect(after.ok).toBe(true);
  });

  it("keeps the cached balance equal to the journal for every account", async () => {
    const a = await makeAccount(uniqueHandle("a"), { balance: "77.77" });
    const b = await makeAccount(uniqueHandle("b"));

    await withTransaction((db) =>
      postTransfer(db, {
        lines: [
          { accountHandle: a, amount: bdt("-7.77") },
          { accountHandle: b, amount: bdt("7.77") },
        ],
      }),
    );

    expect(await balanceOf(a)).toBe(await derivedBalanceOf(a));
    expect(await balanceOf(b)).toBe(await derivedBalanceOf(b));
  });
});
