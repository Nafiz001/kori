import { withTransaction } from "./db/pool.js";
import { createAccount, getAccountByHandle, postTransfer } from "./ledger/ledger.js";
import { parseAmount } from "./money/money.js";

/**
 * The accounts behind the public demo: a small marketplace with three
 * customers, two merchants, a fee account and the bank that money enters
 * from.
 *
 * It is safe to run again. If the bank account is already there nothing is
 * touched, so a container restart never tops anyone up a second time.
 */
export const DEMO_BANK = "bank:external";

const WALLETS: Array<{ handle: string; name: string; opening: string }> = [
  { handle: "user:alice/wallet", name: "Alice", opening: "5000.00" },
  { handle: "user:bimal/wallet", name: "Bimal", opening: "1200.00" },
  { handle: "user:chitra/wallet", name: "Chitra", opening: "300.00" },
  { handle: "merchant:books/wallet", name: "Pathshala Books", opening: "0.00" },
  { handle: "merchant:tea/wallet", name: "Sreemangal Tea", opening: "0.00" },
];

export async function seedDemoLedger(): Promise<{ created: boolean }> {
  const already = await withTransaction((db) => getAccountByHandle(db, DEMO_BANK));
  if (already) return { created: false };

  await withTransaction(async (db) => {
    // Where money enters from outside. An equity account that may go
    // negative, because it stands for value that came from beyond the ledger.
    await createAccount(db, {
      handle: DEMO_BANK,
      name: "External bank",
      currency: "BDT",
      kind: "equity",
      allowNegative: true,
    });
    await createAccount(db, {
      handle: "platform:fees",
      name: "Platform fees",
      currency: "BDT",
      kind: "revenue",
    });
    for (const wallet of WALLETS) {
      await createAccount(db, {
        handle: wallet.handle,
        name: wallet.name,
        currency: "BDT",
        kind: "liability",
      });
    }

    for (const wallet of WALLETS) {
      if (wallet.opening === "0.00") continue;
      await postTransfer(db, {
        kind: "deposit",
        reference: `seed:${wallet.handle}`,
        description: `Opening balance for ${wallet.name}`,
        lines: [
          { accountHandle: DEMO_BANK, amount: parseAmount("BDT", `-${wallet.opening}`) },
          { accountHandle: wallet.handle, amount: parseAmount("BDT", wallet.opening) },
        ],
      });
    }
  });

  return { created: true };
}
