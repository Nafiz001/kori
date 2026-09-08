import { config } from "./config.js";
import { closePool, withTransaction } from "./db/pool.js";
import { logger } from "./observability/logger.js";
import { claimPending, markFailed, markPublished, type PendingEvent } from "./outbox/outbox.js";

/**
 * The outbox worker: read events the ledger wrote, publish them, mark them done.
 *
 * It runs as its own process rather than a timer inside the API. Two reasons:
 * a slow or failing consumer must not be able to add latency to a payment, and
 * the worker can be scaled or restarted without touching the thing taking
 * money.
 *
 * `publish` here writes to the log. Substituting Kafka, SQS, RabbitMQ or a
 * webhook is a change to this one function -- everything about the delivery
 * guarantee lives in the table and the claim query, not in the transport.
 */
export type Publisher = (event: PendingEvent) => Promise<void>;

const logPublisher: Publisher = async (event) => {
  logger.info(
    { topic: event.topic, aggregateId: event.aggregateId, payload: event.payload },
    "published event",
  );
};

export interface WorkerOptions {
  publish?: Publisher;
  batchSize?: number;
  maxAttempts?: number;
}

/**
 * Process one batch. Returns how many events were handled.
 *
 * Each event is claimed, published and marked inside one transaction, so a
 * worker that dies mid-batch releases its rows and another picks them up. The
 * publish itself happens inside that transaction, which is what makes delivery
 * at-least-once: if the process dies after publishing but before committing,
 * the event is published again. Exactly-once is not available here, and
 * pretending otherwise would be the bug.
 */
export async function drainOnce(options: WorkerOptions = {}): Promise<number> {
  const cfg = config();
  const publish = options.publish ?? logPublisher;
  const batchSize = options.batchSize ?? cfg.OUTBOX_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? cfg.OUTBOX_MAX_ATTEMPTS;

  return withTransaction(async (db) => {
    const events = await claimPending(db, batchSize);

    for (const event of events) {
      try {
        await publish(event);
        await markPublished(db, event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ id: event.id, topic: event.topic, err: message }, "publish failed");
        await markFailed(db, event.id, message, maxAttempts);
      }
    }

    return events.length;
  });
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const cfg = config();
  let running = true;

  process.on("SIGTERM", () => {
    running = false;
  });
  process.on("SIGINT", () => {
    running = false;
  });

  logger.info({ batchSize: cfg.OUTBOX_BATCH_SIZE }, "outbox worker started");

  while (running) {
    try {
      const handled = await drainOnce(options);
      // Sleep only when there was nothing to do. A busy worker keeps working,
      // so a backlog drains at full speed instead of one batch per tick.
      if (handled === 0) {
        await new Promise((resolve) => setTimeout(resolve, cfg.OUTBOX_POLL_MS));
      }
    } catch (error) {
      logger.error({ err: error }, "worker iteration failed");
      await new Promise((resolve) => setTimeout(resolve, cfg.OUTBOX_POLL_MS));
    }
  }

  await closePool();
  logger.info("outbox worker stopped");
}

// Only run when executed directly, so the tests can import drainOnce.
if (process.argv[1]?.endsWith("worker.ts") || process.argv[1]?.endsWith("worker.js")) {
  runWorker().catch((error) => {
    logger.fatal({ err: error }, "worker failed");
    process.exit(1);
  });
}
