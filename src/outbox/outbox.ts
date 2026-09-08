import type { Db } from "../db/pool.js";

/**
 * The transactional outbox.
 *
 * The problem it solves: a transfer commits to the database and an event about
 * it has to reach the rest of the system. Doing those as two separate steps has
 * no correct ordering.
 *
 *   - Commit, then publish: the process can die in between. The money moved and
 *     nobody was told, forever.
 *   - Publish, then commit: the transaction can fail. Everyone was told about a
 *     transfer that never happened.
 *
 * Writing the event into the same database transaction removes the gap
 * entirely: "the money moved" and "an event exists saying so" become one atomic
 * fact. A separate worker then reads the table and publishes.
 *
 * The cost is that delivery becomes at-least-once — the worker can publish and
 * then crash before recording that it did — so consumers have to be idempotent.
 * That is the correct trade, and it is the same one every message queue makes.
 */

export interface OutboxEvent {
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface PendingEvent extends OutboxEvent {
  id: string;
  attempts: number;
  createdAt: Date;
}

/**
 * Write an event. Takes the caller's `Db`, which is the whole point: it must be
 * the same transaction that made the change being announced.
 */
export async function enqueueEvent(db: Db, event: OutboxEvent): Promise<void> {
  await db.query(
    `INSERT INTO outbox (topic, aggregate_id, payload) VALUES ($1, $2, $3)`,
    [event.topic, event.aggregateId, JSON.stringify(event.payload)],
  );
}

/**
 * Claim a batch of events to publish.
 *
 * `FOR UPDATE SKIP LOCKED` is what allows more than one worker to run. Without
 * SKIP LOCKED, a second worker blocks on the rows the first has locked and the
 * throughput of the whole system is one worker's. With it, each worker takes a
 * disjoint batch and they scale out.
 *
 * The rows are claimed inside the caller's transaction and stay locked until it
 * ends, so a worker that dies mid-batch releases them and another picks them up.
 */
export async function claimPending(db: Db, limit: number): Promise<PendingEvent[]> {
  const { rows } = await db.query<{
    id: string;
    topic: string;
    aggregate_id: string;
    payload: Record<string, unknown>;
    attempts: number;
    created_at: Date;
  }>(
    `SELECT id, topic, aggregate_id, payload, attempts, created_at
       FROM outbox
      WHERE published_at IS NULL
        AND next_attempt_at <= now()
      ORDER BY id
      LIMIT $1
        FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  return rows.map((row) => ({
    id: String(row.id),
    topic: row.topic,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    attempts: row.attempts,
    createdAt: row.created_at,
  }));
}

export async function markPublished(db: Db, id: string): Promise<void> {
  await db.query("UPDATE outbox SET published_at = now() WHERE id = $1", [id]);
}

/**
 * Record a failure and schedule a retry with exponential backoff.
 *
 * The backoff is capped, and so is the attempt count: an event that a consumer
 * will never accept should stop consuming the worker's attention rather than
 * being retried forever. Once it exceeds the cap it stays pending with a far
 * future retry time, which leaves it visible to an operator instead of quietly
 * discarding it.
 */
export async function markFailed(
  db: Db,
  id: string,
  error: string,
  maxAttempts: number,
): Promise<void> {
  await db.query(
    `UPDATE outbox
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = now() + (
              CASE WHEN attempts + 1 >= $3 THEN interval '1 day'
                   ELSE least(interval '5 minutes',
                              interval '1 second' * power(2, attempts + 1))
              END
            )
      WHERE id = $1`,
    [id, error.slice(0, 1000), maxAttempts],
  );
}

export async function pendingCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL",
  );
  return Number(rows[0]?.count ?? 0);
}

/** Events waiting far longer than expected, which is what an alert would watch. */
export async function stalledCount(db: Db, olderThanSeconds = 60): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM outbox
      WHERE published_at IS NULL
        AND created_at < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)],
  );
  return Number(rows[0]?.count ?? 0);
}
