import express, { type Express } from "express";
import { pinoHttp } from "pino-http";

import { config } from "../config.js";
import { query } from "../db/pool.js";
import { logger } from "../observability/logger.js";
import { metricsHandler, observeRequest } from "../observability/metrics.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { authenticate, requestId } from "./middleware.js";
import { rateLimit } from "./rateLimit.js";
import { buildRoutes } from "./routes.js";

/**
 * The application, assembled but not listening.
 *
 * Separating construction from binding is what makes the whole API testable
 * in-process: supertest drives this object directly, so the integration tests
 * exercise the real middleware chain -- auth, validation, idempotency, error
 * mapping -- without a port, a race on startup, or a socket to clean up.
 */
export function buildApp(): Express {
  const app = express();

  // Express reports req.ip from X-Forwarded-For only when told it is behind a
  // proxy. Left off, every request behind a load balancer looks like it came
  // from the balancer, and per-IP rate limiting becomes per-cluster.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(requestId());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { requestId?: string }).requestId ?? "unknown",
      // The Authorization header must never reach the logs. Redaction here
      // rather than at each call site means it cannot be forgotten.
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["idempotency-key"]'],
        remove: true,
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use(observeRequest());

  // A body limit, because the default is 100kb and a ledger request has no
  // legitimate reason to be large. Parsing megabytes of JSON is free work for
  // an attacker to hand the server.
  app.use(express.json({ limit: "64kb" }));

  // -------------------------------------------------------------------------
  // Health and metrics: before auth, because a probe has no credentials.
  // -------------------------------------------------------------------------

  // Liveness: is the process running. Deliberately does not touch the database
  // -- if it did, a database blip would make the orchestrator restart every
  // healthy instance, turning a partial outage into a total one.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: can this instance actually serve. This one does check the
  // database, because an instance that cannot reach it should be taken out of
  // the load balancer rather than restarted.
  app.get("/health/ready", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ready" });
    } catch (error) {
      res.status(503).json({
        status: "not_ready",
        reason: error instanceof Error ? error.message : "database unreachable",
      });
    }
  });

  app.get("/metrics", metricsHandler());

  // -------------------------------------------------------------------------
  // The API
  // -------------------------------------------------------------------------

  const cfg = config();

  app.use(
    "/v1",
    authenticate(),
    // Rate limiting after authentication, so the limit is per API key rather
    // than per IP. Limiting by IP alone punishes everyone behind one NAT.
    rateLimit(cfg.RATE_LIMIT_PER_MINUTE),
    buildRoutes(),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
