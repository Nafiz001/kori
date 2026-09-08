import { config } from "./config.js";
import { closePool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./http/app.js";
import { closeRedis } from "./http/rateLimit.js";
import { logger } from "./observability/logger.js";

/**
 * The server.
 *
 * Migrations run at startup. That is the right call for a single-service
 * deployment and worth knowing about: with several instances starting at once
 * they race, and PostgreSQL's transactional DDL means the losers fail rather
 * than corrupt anything. At more than one instance this moves to a job that
 * runs before the rollout.
 */
async function main(): Promise<void> {
  const cfg = config();

  await migrate((msg) => logger.info(msg));

  const app = buildApp();
  const server = app.listen(cfg.PORT, cfg.HOST, () => {
    logger.info({ host: cfg.HOST, port: cfg.PORT, env: cfg.NODE_ENV }, "kori listening");
  });

  /**
   * Shut down gracefully.
   *
   * Stop accepting new connections, let the in-flight ones finish, then close
   * the database. Exiting immediately would abort requests that had already
   * committed a transfer but not yet told the client, and the client would then
   * retry something that had in fact succeeded.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const timer = setTimeout(() => {
      logger.error("graceful shutdown timed out; exiting anyway");
      process.exit(1);
    }, 15_000);
    timer.unref();

    server.close(async () => {
      await closePool();
      await closeRedis();
      logger.info("shutdown complete");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
