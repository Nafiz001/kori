import pino from "pino";

import { config } from "../config.js";

/**
 * Structured logging.
 *
 * JSON rather than formatted text, because logs are read by machines far more
 * often than by people: a grep for a request id across a cluster is the common
 * case, and prose does not survive that. Pretty printing is a development
 * convenience layered on top, never the wire format.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "kori" },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never log a secret, wherever it turns up in an object being serialised.
  redact: {
    paths: ["password", "secret", "token", "apiKey", "authorization", "*.password", "*.secret"],
    censor: "[redacted]",
  },
  formatters: {
    // pino writes `level: 30` by default. The number is compact and unreadable
    // in a log viewer, and every aggregator wants the name.
    level: (label) => ({ level: label }),
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
