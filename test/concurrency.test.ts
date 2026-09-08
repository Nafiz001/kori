import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, getPool, withTransaction } from "../src/db/pool.js";
import { LedgerError, postTransfer } from "../src/ledger/ledger.js";
import { verifyLedger } from "../src/ledger/verify.js";
import { parseAmount } from "../src/money/money.js";
import { attempt, balanceOf, countEntries, ensureSchema, makeAccount, uniqueHandle } from "./helpers.js";

/**
 * Concurrency.
 *
 * These are the tests the locking exists for, and they are the only ones that
 * can tell whether it works. A ledger that is correct one request at a time and
 * wrong under load is wrong, and the failure looks like an accounting
 * discrepancy weeks later rather than an exception at the time.
 *
 * Every test here runs real overlapping transactions against real PostgreSQL.
 * There is no way to fake this: the bug being hunted -- two transactions
 * reading the same balance and both deciding a withdrawal is affordable -- only
 * exists when two connections are genuinely in flight at once.
 */

const bdt = (text: string) => parseAmount("BDT", text);

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closePool();
});

describe("lost updates", () => {
  it("applies every concurrent credit exactly once", async () => {
    const source = await makeAccount(uniqueHandle("src"), { balance: "1000.00", allowNegative: true });
    const target = await makeAccount(uniqueHandle("dst"));

    // Fifty transfers of one taka, all in flight together. Read-modify-write
    // without a lock loses most of them and leaves a balance far below 50.
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: source, amount: bdt("-1.00") },
              { accountHandle: target, amount: bdt("1.00") },
            ],
          }),
        ),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(await balanceOf(target)).toBe(BigInt(N) * 100n);
    expect(await countEntries(target)).toBe(N);
  });

  it("keeps the total constant while money moves in every direction", async () => {
    // Five accounts passing money around at random, concurrently. Whatever
    // interleaving occurs, a closed system cannot change its own total.
    const handles = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        makeAccount(uniqueHandle(`ring${i}`), { balance: "100.00" }),
      ),
    );

    const before = (await Promise.all(handles.map(balanceOf))).reduce((a, b) => a + b, 0n);

    await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const from = handles[i % handles.length]!;
        const to = handles[(i * 3 + 1) % handles.length]!;
        if (from === to) return Promise.resolve(null);
        return attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: from, amount: bdt("-1.00") },
              { accountHandle: to, amount: bdt("1.00") },
            ],
          }),
        );
      }),
    );

    const after = (await Promise.all(handles.map(balanceOf))).reduce((a, b) => a + b, 0n);
    expect(after).toBe(before);
  });
});

describe("overdraft under contention", () => {
  it("lets through exactly as many withdrawals as the balance covers", async () => {
    // The canonical double-spend. The account holds 10.00 and twenty requests
    // each try to take 1.00 at the same moment. Exactly ten must succeed.
    //
    // Without SELECT ... FOR UPDATE, every request reads 10.00, every request
    // decides it can afford 1.00, and the balance ends up negative -- with no
    // single request having done anything wrong.
    const account = await makeAccount(uniqueHandle("thin"), { balance: "10.00" });
    const sink = await makeAccount(uniqueHandle("sink"));

    const attempts = 20;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: account, amount: bdt("-1.00") },
              { accountHandle: sink, amount: bdt("1.00") },
            ],
          }),
        ),
      ),
    );

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);

    expect(succeeded).toBe(10);
    expect(failed).toHaveLength(10);

    // Every rejection must be a clean insufficient_funds, and this is the
    // assertion that is actually sensitive to the lock.
    //
    // Removing FOR UPDATE does not lose money -- the balance is updated with
    // `balance = balance + delta`, which PostgreSQL applies atomically, and the
    // CHECK constraint on the account refuses a negative result. What breaks is
    // the *diagnosis*: the affordability check reads a stale balance, lets a
    // doomed transfer through, and the client gets a raw constraint violation
    // instead of being told it has insufficient funds. The lock is what makes
    // the error correct, and the constraint is what makes the ledger safe even
    // if the lock were ever lost.
    expect(
      failed.every((r) => (r as { error: LedgerError }).error.code === "insufficient_funds"),
    ).toBe(true);

    expect(await balanceOf(account)).toBe(0n);
    expect(await balanceOf(sink)).toBe(1000n);
  });

  it("never lets a balance go negative, whatever the interleaving", async () => {
    const account = await makeAccount(uniqueHandle("guard"), { balance: "5.00" });
    const sink = await makeAccount(uniqueHandle("sink"));

    // Amounts that do not divide evenly, so the order in which requests are
    // granted changes which of them fit.
    const amounts = ["2.00", "3.00", "1.50", "4.00", "0.75", "2.25", "5.00", "1.00"];

    await Promise.all(
      amounts.map((amount) =>
        attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: account, amount: bdt(`-${amount}`) },
              { accountHandle: sink, amount: bdt(amount) },
            ],
          }),
        ),
      ),
    );

    const balance = await balanceOf(account);
    expect(balance >= 0n).toBe(true);
    // Whatever got through, the two sides still agree.
    expect(balance + (await balanceOf(sink))).toBe(500n);
  });
});

describe("deadlock avoidance", () => {
  it("survives transfers that cross in opposite directions", async () => {
    /*
     * A deadlock needs two transactions to take the same locks in opposite
     * orders: one locks A then B, the other locks B then A, and both wait
     * forever until PostgreSQL kills one.
     *
     * postTransfer sorts account handles before locking, so every transaction
     * in the system acquires locks in the same sequence and a cycle cannot
     * form. This test drives exactly the pattern that would deadlock without
     * that sort -- pairs of transfers running in both directions at once.
     */
    const a = await makeAccount(uniqueHandle("cross-a"), { balance: "500.00" });
    const b = await makeAccount(uniqueHandle("cross-b"), { balance: "500.00" });
    const c = await makeAccount(uniqueHandle("cross-c"), { balance: "500.00" });

    const pairs: Array<[string, string]> = [
      [a, b], [b, a],
      [b, c], [c, b],
      [a, c], [c, a],
    ];

    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const [from, to] = pairs[i % pairs.length]!;
        return attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: from, amount: bdt("-1.00") },
              { accountHandle: to, amount: bdt("1.00") },
            ],
          }),
        );
      }),
    );

    // No deadlock: PostgreSQL reports 40P01 when it breaks one, and nothing
    // here should ever see it.
    const deadlocks = results.filter(
      (r) => !r.ok && (r.error as { code?: string }).code === "40P01",
    );
    expect(deadlocks).toHaveLength(0);
    expect(results.every((r) => r.ok)).toBe(true);

    // The three accounts started with 1500.00 between them and still hold it.
    const total = (await balanceOf(a)) + (await balanceOf(b)) + (await balanceOf(c));
    expect(total).toBe(150_000n);
  });

  it("handles a many-account transfer racing against a two-account one", async () => {
    const handles = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makeAccount(uniqueHandle(`m${i}`), { balance: "200.00" })),
    );

    const wide = () =>
      attempt((db) =>
        postTransfer(db, {
          lines: [
            { accountHandle: handles[0]!, amount: bdt("-5.00") },
            { accountHandle: handles[1]!, amount: bdt("1.00") },
            { accountHandle: handles[2]!, amount: bdt("1.00") },
            { accountHandle: handles[3]!, amount: bdt("1.00") },
            { accountHandle: handles[4]!, amount: bdt("1.00") },
            { accountHandle: handles[5]!, amount: bdt("1.00") },
          ],
        }),
      );

    const narrow = (i: number) =>
      attempt((db) =>
        postTransfer(db, {
          lines: [
            { accountHandle: handles[(i + 1) % 6]!, amount: bdt("-1.00") },
            { accountHandle: handles[i % 6]!, amount: bdt("1.00") },
          ],
        }),
      );

    const before = (await Promise.all(handles.map(balanceOf))).reduce((a, b) => a + b, 0n);

    const results = await Promise.all([
      ...Array.from({ length: 15 }, wide),
      ...Array.from({ length: 30 }, (_, i) => narrow(i)),
    ]);

    const deadlocks = results.filter(
      (r) => !r.ok && (r.error as { code?: string }).code === "40P01",
    );
    expect(deadlocks).toHaveLength(0);

    const after = (await Promise.all(handles.map(balanceOf))).reduce((a, b) => a + b, 0n);
    expect(after).toBe(before);
  });
});

describe("the ledger stays consistent under load", () => {
  it("balances and journal still agree after concurrent traffic", async () => {
    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makeAccount(uniqueHandle(`load${i}`), { balance: "50.00" })),
    );

    await Promise.all(
      Array.from({ length: 120 }, (_, i) => {
        const from = handles[i % handles.length]!;
        const to = handles[(i * 5 + 3) % handles.length]!;
        if (from === to) return Promise.resolve(null);
        return attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: from, amount: bdt("-0.25") },
              { accountHandle: to, amount: bdt("0.25") },
            ],
          }),
        );
      }),
    );

    // The full verification pass: every cached balance re-derived from the
    // journal, every transfer summed, the whole ledger checked for
    // conservation. If concurrency broke anything, this is where it shows.
    const report = await withTransaction((db) => verifyLedger(db));
    if (!report.ok) console.error(report.problems);
    expect(report.ok).toBe(true);
  });

  it("never writes a balance the journal disagrees with", async () => {
    const a = await makeAccount(uniqueHandle("audit-a"), { balance: "100.00" });
    const b = await makeAccount(uniqueHandle("audit-b"), { balance: "100.00" });

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        attempt((db) =>
          postTransfer(db, {
            lines: [
              { accountHandle: i % 2 === 0 ? a : b, amount: bdt("-1.00") },
              { accountHandle: i % 2 === 0 ? b : a, amount: bdt("1.00") },
            ],
          }),
        ),
      ),
    );

    // balance_after on the newest entry must equal the account's balance. This
    // catches an interleaving where two transactions computed their running
    // balance from a stale read even though the final total happened to work
    // out.
    for (const handle of [a, b]) {
      const { rows } = await getPool().query<{ balance: bigint; balance_after: bigint }>(
        `SELECT a.balance, e.balance_after
           FROM accounts a
           JOIN entries e ON e.account_id = a.id
          WHERE a.handle = $1
          ORDER BY e.id DESC
          LIMIT 1`,
        [handle],
      );
      expect(rows[0]!.balance_after, handle).toBe(rows[0]!.balance);
    }
  });
});
