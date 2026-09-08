/**
 * A worked example: a marketplace payment, a platform fee, and a refund.
 *
 * This exists because "double-entry ledger" is abstract until you watch the
 * numbers move. Every transfer below balances to zero, no money is created or
 * destroyed at any point, and the refund is a new transfer rather than an edit
 * to the old one -- which is what makes the final statement tell the truth
 * about what happened rather than only about where things ended up.
 *
 *   npm run demo
 */

import { closePool, withTransaction } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import {
  createAccount,
  getAccountByHandle,
  listEntries,
  postTransfer,
  reverseTransfer,
} from "./ledger/ledger.js";
import { verifyLedger } from "./ledger/verify.js";
import { formatAmount, parseAmount } from "./money/money.js";

const bdt = (text: string) => parseAmount("BDT", text);

const suffix = Date.now().toString(36);
const CUSTOMER = `demo:${suffix}:customer`;
const MERCHANT = `demo:${suffix}:merchant`;
const FEES = `demo:${suffix}:platform-fees`;
const BANK = `demo:${suffix}:bank`;

async function show(title: string): Promise<void> {
  const handles = [BANK, CUSTOMER, MERCHANT, FEES];
  const accounts = await withTransaction(async (db) => {
    // One at a time: a single connection cannot run queries concurrently.
    const out = [];
    for (const handle of handles) out.push(await getAccountByHandle(db, handle));
    return out;
  });

  console.log(`\n${title}`);
  console.log("  " + "-".repeat(52));
  let total = 0n;
  for (const account of accounts) {
    if (!account) continue;
    const label = account.handle.split(":").pop()!;
    console.log(
      `  ${label.padEnd(16)} ${formatAmount(account.balance).padStart(12)} BDT   (${account.kind})`,
    );
    total += account.balance.minor;
  }
  // The sum across every account is always zero. That is not a coincidence to
  // be checked at the end -- it is what double-entry means, and it holds after
  // every single transfer.
  console.log("  " + "-".repeat(52));
  console.log(`  ${"sum of all".padEnd(16)} ${formatAmount({ currency: "BDT", minor: total }).padStart(12)} BDT`);
}

async function main(): Promise<void> {
  await migrate();

  console.log("kori demo: a marketplace payment, a fee, and a refund\n");

  // The bank account is where money enters the system from outside. It is an
  // equity account allowed to go negative, because what it really represents
  // is "value that came from beyond this ledger's boundary".
  await withTransaction(async (db) => {
    await createAccount(db, {
      handle: BANK, name: "External bank", currency: "BDT",
      kind: "equity", allowNegative: true,
    });
    await createAccount(db, {
      handle: CUSTOMER, name: "Customer wallet", currency: "BDT", kind: "liability",
    });
    await createAccount(db, {
      handle: MERCHANT, name: "Merchant wallet", currency: "BDT", kind: "liability",
    });
    await createAccount(db, {
      handle: FEES, name: "Platform fees", currency: "BDT", kind: "revenue",
    });
  });

  await show("1. Four accounts, all empty");

  // --- The customer tops up ---------------------------------------------
  await withTransaction((db) =>
    postTransfer(db, {
      kind: "deposit",
      reference: `demo-${suffix}-topup`,
      description: "Customer tops up from their bank",
      lines: [
        { accountHandle: BANK, amount: bdt("-2000.00") },
        { accountHandle: CUSTOMER, amount: bdt("2000.00") },
      ],
    }),
  );

  await show("2. Customer deposits 2000.00");

  // --- The customer buys something --------------------------------------
  //
  // One transfer, three lines. The customer pays 1500.00; the merchant
  // receives 1462.50 and the platform keeps 2.5% as a fee. Doing this as one
  // transfer rather than two is the point: the fee cannot exist without the
  // payment, and one atomic movement makes that structural.
  const payment = await withTransaction((db) =>
    postTransfer(db, {
      kind: "transfer",
      reference: `demo-${suffix}-order-1`,
      description: "Order #1",
      metadata: { orderId: "1", feeRate: "2.5%" },
      lines: [
        { accountHandle: CUSTOMER, amount: bdt("-1500.00") },
        { accountHandle: MERCHANT, amount: bdt("1462.50") },
        { accountHandle: FEES, amount: bdt("37.50") },
      ],
    }),
  );

  await show("3. Customer pays 1500.00, platform keeps 2.5%");

  // --- The order is refunded --------------------------------------------
  //
  // A reversal, not a deletion. The original transfer stays in the journal
  // exactly as it was, and a new transfer with the opposite entries is posted
  // alongside it. The customer ends up whole and the history says what
  // actually happened.
  await withTransaction((db) => reverseTransfer(db, payment.id, "Order #1 refunded"));

  await show("4. Order #1 refunded");

  // --- What the customer's statement says --------------------------------
  const entries = await withTransaction((db) => listEntries(db, CUSTOMER, 10));

  console.log("\n5. The customer's statement, newest first");
  console.log("  " + "-".repeat(52));
  for (const entry of entries) {
    const amount = formatAmount(entry.amount).padStart(11);
    const balance = formatAmount(entry.balanceAfter).padStart(11);
    console.log(`  ${amount} BDT     balance ${balance} BDT`);
  }
  console.log(
    "\n  Three entries, not one. The refund did not erase the payment;\n" +
      "  it added the opposite movement next to it.",
  );

  // --- And the books still balance ---------------------------------------
  const report = await withTransaction((db) => verifyLedger(db));
  console.log(
    `\n6. Verification: ${report.accountsChecked} accounts and ` +
      `${report.transfersChecked} transfers re-derived from the journal in ${report.durationMs}ms`,
  );
  console.log(
    report.ok
      ? "   every cached balance matches the journal, and all entries sum to zero"
      : `   ${report.problems.length} PROBLEM(S): ${JSON.stringify(report.problems, null, 2)}`,
  );

  await closePool();
  if (!report.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exit(1);
});
