import { randomUUID } from "node:crypto";

import {
  type CurrencyCode,
  type Money,
  formatAmount,
  isCurrencyCode,
  money,
  sum,
} from "../money/money.js";
import { type Db, isPgError, PgError, pgConstraint } from "../db/pool.js";
import { enqueueEvent } from "../outbox/outbox.js";

export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  id: string;
  handle: string;
  name: string;
  currency: CurrencyCode;
  kind: AccountKind;
  balance: Money;
  allowNegative: boolean;
  frozen: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface Entry {
  id: string;
  transferId: string;
  accountId: string;
  accountHandle: string;
  amount: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type TransferKind = "transfer" | "deposit" | "withdrawal" | "fee" | "reversal" | "adjustment";

export interface Transfer {
  id: string;
  reference: string | null;
  kind: TransferKind;
  currency: CurrencyCode;
  status: "posted" | "reversed";
  reverses: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  entries: Entry[];
}

/** One line of a transfer: move `amount` into `accountHandle`, signed. */
export interface PostingLine {
  accountHandle: string;
  amount: Money;
}

export class LedgerError extends Error {
  override readonly name = "LedgerError";
  constructor(
    message: string,
    readonly code: LedgerErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type LedgerErrorCode =
  | "account_not_found"
  | "account_frozen"
  | "insufficient_funds"
  | "currency_mismatch"
  | "unbalanced"
  | "duplicate_reference"
  | "transfer_not_found"
  | "already_reversed"
  | "invalid_request";

interface AccountRow {
  id: string;
  handle: string;
  name: string;
  currency: string;
  kind: AccountKind;
  balance: bigint;
  allow_negative: boolean;
  frozen: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function toAccount(row: AccountRow): Account {
  const currency = row.currency.trim();
  if (!isCurrencyCode(currency)) {
    throw new LedgerError(`account ${row.handle} has unknown currency ${currency}`, "invalid_request");
  }
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    currency,
    kind: row.kind,
    balance: money(currency, row.balance),
    allowNegative: row.allow_negative,
    frozen: row.frozen,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  handle: string;
  name: string;
  currency: CurrencyCode;
  kind: AccountKind;
  allowNegative?: boolean;
  metadata?: Record<string, unknown>;
}

export async function createAccount(db: Db, input: CreateAccountInput): Promise<Account> {
  const id = randomUUID();
  try {
    const { rows } = await db.query<AccountRow>(
      `INSERT INTO accounts (id, handle, name, currency, kind, allow_negative, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.handle,
        input.name,
        input.currency,
        input.kind,
        input.allowNegative ?? false,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return toAccount(rows[0]!);
  } catch (error) {
    if (isPgError(error, PgError.UNIQUE_VIOLATION)) {
      throw new LedgerError(`account ${input.handle} already exists`, "invalid_request", {
        handle: input.handle,
      });
    }
    throw error;
  }
}

export async function getAccountByHandle(db: Db, handle: string): Promise<Account | null> {
  const { rows } = await db.query<AccountRow>("SELECT * FROM accounts WHERE handle = $1", [handle]);
  return rows[0] ? toAccount(rows[0]) : null;
}

export async function listAccounts(db: Db, limit = 100, offset = 0): Promise<Account[]> {
  const { rows } = await db.query<AccountRow>(
    "SELECT * FROM accounts ORDER BY created_at DESC, handle LIMIT $1 OFFSET $2",
    [limit, offset],
  );
  return rows.map(toAccount);
}

// ---------------------------------------------------------------------------
// Posting a transfer
// ---------------------------------------------------------------------------

export interface PostTransferInput {
  lines: PostingLine[];
  kind?: TransferKind;
  reference?: string | undefined;
  description?: string | undefined;
  metadata?: Record<string, unknown>;
}

/**
 * Post a transfer: the one function that moves money.
 *
 * Everything else in kori is bookkeeping around this. It must run inside a
 * transaction, and the caller supplies it, because posting a transfer is
 * frequently one part of a larger unit of work -- claiming an idempotency key
 * and writing the outbox event both have to commit or fail with it.
 *
 * The two hard parts are stated where they happen: locking, and the balance
 * invariant.
 */
export async function postTransfer(db: Db, input: PostTransferInput): Promise<Transfer> {
  if (input.lines.length < 2) {
    throw new LedgerError(
      "a transfer needs at least two lines; double-entry has no single-sided posting",
      "unbalanced",
    );
  }

  // One currency per transfer. A cross-currency movement is two transfers
  // joined by an exchange account, so that each set of books balances on its
  // own -- summing taka and dollars into one zero would be meaningless.
  const currencies = new Set(input.lines.map((line) => line.amount.currency));
  if (currencies.size !== 1) {
    throw new LedgerError(
      `a transfer must be in one currency, got ${[...currencies].join(", ")}`,
      "currency_mismatch",
    );
  }
  const currency = [...currencies][0]!;

  // The books must balance. The database enforces this too, with a deferred
  // constraint trigger, but catching it here produces an error that names the
  // imbalance instead of a constraint violation.
  const imbalance = sum(currency, input.lines.map((line) => line.amount));
  if (imbalance.minor !== 0n) {
    throw new LedgerError(
      `transfer is out of balance by ${formatAmount(imbalance)} ${currency}`,
      "unbalanced",
      { imbalance: imbalance.minor.toString() },
    );
  }

  for (const line of input.lines) {
    if (line.amount.minor === 0n) {
      throw new LedgerError(`line for ${line.accountHandle} moves nothing`, "invalid_request");
    }
  }

  // Combine repeated mentions of one account into a single line, so that
  // locking and the per-account net movement are both computed once.
  const netByHandle = new Map<string, bigint>();
  for (const line of input.lines) {
    netByHandle.set(line.accountHandle, (netByHandle.get(line.accountHandle) ?? 0n) + line.amount.minor);
  }

  /*
   * Lock every account this transfer touches, in a deterministic order.
   *
   * The lock is what makes concurrent transfers correct. Without SELECT ... FOR
   * UPDATE, two overlapping transfers both read a balance of 100, both decide
   * a withdrawal of 80 is affordable, and both write 20 -- a lost update, and
   * an overdraft that no single request was ever wrong about.
   *
   * Ordering the handles is what makes it deadlock-free. If one transaction
   * locks A then B while another locks B then A, both wait forever and
   * PostgreSQL kills one of them. Sorting means every transaction in the
   * system acquires locks in the same sequence, so a cycle cannot form.
   */
  const handles = [...netByHandle.keys()].sort();

  const { rows: lockedRows } = await db.query<AccountRow>(
    `SELECT * FROM accounts
      WHERE handle = ANY($1::text[])
      ORDER BY handle
        FOR UPDATE`,
    [handles],
  );

  const accounts = new Map<string, Account>();
  for (const row of lockedRows) accounts.set(row.handle, toAccount(row));

  for (const handle of handles) {
    const account = accounts.get(handle);
    if (!account) {
      throw new LedgerError(`no account with handle ${handle}`, "account_not_found", { handle });
    }
    if (account.currency !== currency) {
      throw new LedgerError(
        `account ${handle} is in ${account.currency}, transfer is in ${currency}`,
        "currency_mismatch",
        { handle, accountCurrency: account.currency, transferCurrency: currency },
      );
    }
    if (account.frozen) {
      throw new LedgerError(`account ${handle} is frozen`, "account_frozen", { handle });
    }
  }

  // Check every account can afford its side before writing anything. Doing all
  // the checks first means a rejected transfer produces one clear error rather
  // than a partial write that has to be rolled back.
  for (const [handle, net] of netByHandle) {
    const account = accounts.get(handle)!;
    const after = account.balance.minor + net;
    if (after < 0n && !account.allowNegative) {
      throw new LedgerError(
        `${handle} has ${formatAmount(account.balance)} ${currency}, ` +
          `which cannot cover ${formatAmount(money(currency, -net))}`,
        "insufficient_funds",
        {
          handle,
          balance: account.balance.minor.toString(),
          requested: (-net).toString(),
        },
      );
    }
  }

  const transferId = randomUUID();

  try {
    await db.query(
      `INSERT INTO transfers (id, reference, kind, currency, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        transferId,
        input.reference ?? null,
        input.kind ?? "transfer",
        currency,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (error) {
    if (isPgError(error, PgError.UNIQUE_VIOLATION)) {
      throw new LedgerError(
        `a transfer with reference ${input.reference} already exists`,
        "duplicate_reference",
        { reference: input.reference },
      );
    }
    throw error;
  }

  // Apply the net movement to each account, then write the entries. The
  // balance is updated with `balance + $1` rather than by writing a value read
  // earlier, so the arithmetic happens in the database on the row this
  // transaction holds a lock on.
  const entries: Entry[] = [];

  for (const handle of handles) {
    const account = accounts.get(handle)!;
    const net = netByHandle.get(handle)!;

    const { rows: updated } = await db.query<{ balance: bigint }>(
      "UPDATE accounts SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance",
      [net.toString(), account.id],
    );
    const balanceAfter = updated[0]!.balance;

    const { rows: entryRows } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO entries (transfer_id, account_id, amount, currency, balance_after)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [transferId, account.id, net.toString(), currency, balanceAfter.toString()],
    );

    entries.push({
      id: String(entryRows[0]!.id),
      transferId,
      accountId: account.id,
      accountHandle: handle,
      amount: money(currency, net),
      balanceAfter: money(currency, balanceAfter),
      createdAt: entryRows[0]!.created_at,
    });
  }

  const transfer: Transfer = {
    id: transferId,
    reference: input.reference ?? null,
    kind: input.kind ?? "transfer",
    currency,
    status: "posted",
    reverses: null,
    description: input.description ?? null,
    metadata: input.metadata ?? {},
    createdAt: new Date(),
    entries,
  };

  // The event goes into the outbox inside this same transaction, so "the money
  // moved" and "an event exists saying so" are one atomic fact.
  await enqueueEvent(db, {
    topic: "transfer.posted",
    aggregateId: transferId,
    payload: {
      transferId,
      kind: transfer.kind,
      currency,
      reference: transfer.reference,
      lines: entries.map((entry) => ({
        account: entry.accountHandle,
        amount: entry.amount.minor.toString(),
        balanceAfter: entry.balanceAfter.minor.toString(),
      })),
    },
  });

  return transfer;
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

/**
 * Reverse a transfer by posting its mirror image.
 *
 * The original is never deleted or edited. A reversal is a new transfer whose
 * entries are the negation of the original's, linked back to it. That is what
 * keeps the journal an audit trail: the history says money moved and then moved
 * back, which is what actually happened, rather than pretending it never did.
 */
export async function reverseTransfer(
  db: Db,
  transferId: string,
  description?: string,
): Promise<Transfer> {
  const original = await getTransfer(db, transferId);
  if (!original) {
    throw new LedgerError(`no transfer with id ${transferId}`, "transfer_not_found");
  }
  if (original.status === "reversed") {
    throw new LedgerError(`transfer ${transferId} has already been reversed`, "already_reversed");
  }

  const lines: PostingLine[] = original.entries.map((entry) => ({
    accountHandle: entry.accountHandle,
    amount: money(entry.amount.currency, -entry.amount.minor),
  }));

  const reversal = await postTransfer(db, {
    lines,
    kind: "reversal",
    description: description ?? `reversal of ${transferId}`,
    metadata: { reverses: transferId },
  });

  try {
    await db.query("UPDATE transfers SET reverses = $1 WHERE id = $2", [transferId, reversal.id]);
  } catch (error) {
    // The unique index on `reverses` is what makes a double reversal
    // impossible: two concurrent requests both pass the status check above,
    // and exactly one of them can write this row.
    if (isPgError(error, PgError.UNIQUE_VIOLATION)) {
      throw new LedgerError(`transfer ${transferId} has already been reversed`, "already_reversed");
    }
    throw error;
  }

  await db.query("UPDATE transfers SET status = 'reversed' WHERE id = $1", [transferId]);

  return { ...reversal, reverses: transferId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface TransferRow {
  id: string;
  reference: string | null;
  kind: TransferKind;
  currency: string;
  status: "posted" | "reversed";
  reverses: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function getTransfer(db: Db, id: string): Promise<Transfer | null> {
  const { rows } = await db.query<TransferRow>("SELECT * FROM transfers WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) return null;

  const currency = row.currency.trim();
  if (!isCurrencyCode(currency)) {
    throw new LedgerError(`transfer ${id} has unknown currency ${currency}`, "invalid_request");
  }

  const { rows: entryRows } = await db.query<{
    id: string;
    account_id: string;
    handle: string;
    amount: bigint;
    balance_after: bigint;
    created_at: Date;
  }>(
    `SELECT e.id, e.account_id, a.handle, e.amount, e.balance_after, e.created_at
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
      WHERE e.transfer_id = $1
      ORDER BY e.id`,
    [id],
  );

  return {
    id: row.id,
    reference: row.reference,
    kind: row.kind,
    currency,
    status: row.status,
    reverses: row.reverses,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.created_at,
    entries: entryRows.map((entry) => ({
      id: String(entry.id),
      transferId: id,
      accountId: entry.account_id,
      accountHandle: entry.handle,
      amount: money(currency, entry.amount),
      balanceAfter: money(currency, entry.balance_after),
      createdAt: entry.created_at,
    })),
  };
}

export async function getTransferByReference(db: Db, reference: string): Promise<Transfer | null> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM transfers WHERE reference = $1", [
    reference,
  ]);
  return rows[0] ? getTransfer(db, rows[0].id) : null;
}

/** An account's entries, newest first. The statement of account. */
export async function listEntries(
  db: Db,
  handle: string,
  limit = 50,
  before?: string,
): Promise<Entry[]> {
  const account = await getAccountByHandle(db, handle);
  if (!account) {
    throw new LedgerError(`no account with handle ${handle}`, "account_not_found", { handle });
  }

  const { rows } = await db.query<{
    id: string;
    transfer_id: string;
    amount: bigint;
    balance_after: bigint;
    created_at: Date;
  }>(
    `SELECT id, transfer_id, amount, balance_after, created_at
       FROM entries
      WHERE account_id = $1
        AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC
      LIMIT $3`,
    [account.id, before ?? null, limit],
  );

  return rows.map((row) => ({
    id: String(row.id),
    transferId: row.transfer_id,
    accountId: account.id,
    accountHandle: handle,
    amount: money(account.currency, row.amount),
    balanceAfter: money(account.currency, row.balance_after),
    createdAt: row.created_at,
  }));
}
