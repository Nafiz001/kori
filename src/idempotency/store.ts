import { createHash } from "node:crypto";

import type { Db } from "../db/pool.js";

/**
 * Idempotency.
 *
 * A client that times out does not know whether its request was applied. The
 * only safe thing it can do is retry, and the only safe thing the server can do
 * is recognise the retry and return the original answer rather than moving the
 * money a second time.
 *
 * The mechanism is a key the client supplies and the server records, in the
 * same transaction as the work it protects. Three cases have to be
 * distinguished, and conflating any two of them is a bug:
 *
 *   - Not seen before -> do the work, record the result.
 *   - Seen and finished -> return the recorded result, do nothing.
 *   - Seen and still running -> another request holds this key right now.
 *     Tell the client to retry rather than running the work concurrently.
 *
 * This lives in PostgreSQL rather than Redis, and that is deliberate. The
 * record has to be exactly as durable as the transfer it protects; a cache that
 * can evict under memory pressure would forget the key and let the duplicate
 * through, which is the one failure the whole mechanism exists to prevent.
 */

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type ClaimResult =
  | { outcome: "claimed" }
  | { outcome: "replay"; response: StoredResponse }
  | { outcome: "in_progress" }
  | { outcome: "conflict" };

/**
 * Hash the request so that reusing a key with a different body is caught.
 *
 * Without this, a client that reuses a key by mistake gets back the answer to
 * someone else's request, which is worse than either doing the work or
 * refusing it. Returning a conflict says plainly what happened.
 */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(method)
    .update("\n")
    .update(path)
    .update("\n")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

/**
 * Try to claim a key.
 *
 * The claim is an INSERT, and the primary key is what makes it atomic: two
 * concurrent requests with the same key both try to insert and exactly one
 * succeeds. There is no read-then-write, so there is no window between checking
 * and claiming for them to race in.
 *
 * ON CONFLICT DO NOTHING rather than catching the unique violation, and the
 * difference is not stylistic. In PostgreSQL *any* error inside a transaction
 * aborts it: every subsequent command fails with 25P02, "current transaction is
 * aborted", until the transaction ends. So catching the violation and then
 * reading the existing row cannot work -- the read is one of the commands that
 * gets refused. The alternatives are a SAVEPOINT around the insert or not
 * producing the error in the first place, and the second is cheaper and says
 * what it means.
 */
export async function claimKey(
  db: Db,
  key: string,
  owner: string,
  requestHash: string,
  ttlSeconds: number,
): Promise<ClaimResult> {
  const inserted = await db.query(
    `INSERT INTO idempotency_keys (key, owner, request_hash, status, expires_at)
     VALUES ($1, $2, $3, 'in_progress', now() + ($4 || ' seconds')::interval)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [scopedKey(owner, key), owner, requestHash, String(ttlSeconds)],
  );

  if (inserted.rowCount === 1) {
    return { outcome: "claimed" };
  }

  // The key already exists. Read it to find out which of the other three cases
  // applies.
  const { rows } = await db.query<{
    request_hash: string;
    status: "in_progress" | "completed";
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT request_hash, status, response_status, response_body
       FROM idempotency_keys
      WHERE key = $1`,
    [scopedKey(owner, key)],
  );

  const existing = rows[0];
  if (!existing) {
    // Raced with the sweeper deleting an expired key. Treating it as in
    // progress asks the client to retry, which will then take the clean path.
    return { outcome: "in_progress" };
  }

  if (existing.request_hash !== requestHash) {
    return { outcome: "conflict" };
  }

  if (existing.status === "completed" && existing.response_status !== null) {
    return {
      outcome: "replay",
      response: { status: existing.response_status, body: existing.response_body },
    };
  }

  return { outcome: "in_progress" };
}

/**
 * Record the result. Must run in the same transaction as the work, so that a
 * committed transfer and the record saying it happened are one atomic fact.
 */
export async function completeKey(
  db: Db,
  key: string,
  owner: string,
  response: StoredResponse,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys
        SET status = 'completed',
            response_status = $2,
            response_body = $3,
            completed_at = now()
      WHERE key = $1`,
    [scopedKey(owner, key), response.status, JSON.stringify(response.body)],
  );
}

/**
 * Release a key whose work failed, so the client can retry.
 *
 * A failed request must not leave its key claimed. If it did, the retry would
 * be told "in progress" forever and the client could never get through -- the
 * failure would become permanent for that key rather than transient.
 *
 * This runs on its own connection, outside the failed transaction, because
 * that transaction is about to roll back and anything written inside it would
 * roll back too.
 */
export async function releaseKey(db: Db, key: string, owner: string): Promise<void> {
  await db.query("DELETE FROM idempotency_keys WHERE key = $1 AND status = 'in_progress'", [
    scopedKey(owner, key),
  ]);
}

/**
 * Keys are scoped to their owner, so that two API keys choosing the same
 * idempotency key -- "1", say, which somebody will -- cannot see each other's
 * responses.
 */
function scopedKey(owner: string, key: string): string {
  return `${owner}:${key}`;
}

/** Delete expired keys. Run periodically; without it the table grows forever. */
export async function sweepExpired(db: Db): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM idempotency_keys WHERE expires_at < now()");
  return rowCount ?? 0;
}
