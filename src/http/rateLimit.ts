import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Redis } from "ioredis";

import { config } from "../config.js";
import { ApiError } from "./errors.js";

/**
 * Rate limiting: a sliding window counter in Redis.
 *
 * Redis rather than PostgreSQL here, and that is the opposite choice from
 * idempotency, for a reason worth stating. A lost idempotency record lets a
 * payment happen twice; a lost rate-limit counter lets someone make a few extra
 * requests. The first is unacceptable and the second is a rounding error, so
 * the durable store guards the first and the fast one guards the second.
 *
 * The window is a fixed bucket keyed by the current minute, which is simple and
 * has a known flaw: a client can send a full allowance at 11:59:59 and another
 * at 12:00:00. A sliding log would fix that at the cost of storing every
 * timestamp. For protecting a service from a runaway client, the burst is
 * acceptable and the tradeoff is worth naming rather than hiding.
 */

let redis: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config().REDIS_URL, {
      maxRetriesPerRequest: 2,
      // Fail fast. A rate limiter that blocks on a slow Redis has turned an
      // availability aid into an availability risk.
      connectTimeout: 2000,
      lazyConnect: false,
      enableOfflineQueue: false,
    });

    redis.on("error", (error) => {
      // Logged, not thrown. The handler below decides what a Redis outage
      // means for a request, and it is not "take the process down".
      // eslint-disable-next-line no-console
      console.warn("redis error:", error.message);
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    redis.disconnect();
    redis = undefined;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export async function consume(
  identity: string,
  limit: number,
  windowSeconds = 60,
): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ratelimit:${identity}:${window}`;

  // INCR and EXPIRE in one pipeline, so a client cannot be counted without the
  // key also being given a lifetime. Two round trips with a crash in between
  // would leave a counter that never expires and locks the client out forever.
  const pipeline = getRedis().pipeline();
  pipeline.incr(key);
  pipeline.expire(key, windowSeconds);
  const results = await pipeline.exec();

  const count = Number(results?.[0]?.[1] ?? 0);
  const elapsed = Math.floor(Date.now() / 1000) % windowSeconds;

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds: windowSeconds - elapsed,
  };
}

/**
 * The middleware.
 *
 * It fails open: if Redis is unreachable the request is allowed through. That
 * is a deliberate availability choice for a payments API, where refusing every
 * request because a cache is down converts a minor outage into a total one. The
 * ledger's own correctness never depends on this, so failing open costs
 * throughput protection and nothing else.
 */
export function rateLimit(perMinute?: number): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const limit = perMinute ?? config().RATE_LIMIT_PER_MINUTE;
    // Authenticated callers are limited per key; unauthenticated ones per IP.
    const identity = req.auth?.subject ?? req.ip ?? "unknown";

    let result: RateLimitResult;
    try {
      result = await consume(identity, limit);
    } catch (error) {
      req.log?.warn({ err: error }, "rate limiter unavailable, allowing request");
      return next();
    }

    res.setHeader("ratelimit-limit", String(result.limit));
    res.setHeader("ratelimit-remaining", String(result.remaining));
    res.setHeader("ratelimit-reset", String(result.resetSeconds));

    if (!result.allowed) {
      res.setHeader("retry-after", String(result.resetSeconds));
      return next(
        ApiError.tooManyRequests(
          `rate limit of ${limit} requests per minute exceeded`,
          result.resetSeconds,
        ),
      );
    }

    next();
  };
}
