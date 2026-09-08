import { randomUUID, timingSafeEqual } from "node:crypto";

import argon2 from "argon2";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";

import { config } from "../config.js";
import { query, withTransaction } from "../db/pool.js";
import { claimKey, completeKey, hashRequest, releaseKey } from "../idempotency/store.js";
import { ApiError } from "./errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { subject: string; scopes: string[] };
      requestId?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Request identity
// ---------------------------------------------------------------------------

/**
 * Give every request an id and echo it back.
 *
 * An inbound `x-request-id` is honoured so that a trace started by a gateway or
 * another service stays one trace across the hop. Without that, correlating a
 * failure across two services means guessing from timestamps.
 */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header("x-request-id");
    const id = inbound && inbound.length <= 128 ? inbound : randomUUID();
    req.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface ApiKeyParts {
  prefix: string;
  secret: string;
}

/**
 * An API key is `kori_<prefix>_<secret>`.
 *
 * The prefix is stored in clear and the secret is hashed with Argon2id. The
 * split is what makes both possible at once: a key can be identified in a list
 * or an audit log by its prefix, while a leaked database yields no working
 * credentials.
 *
 * Argon2 rather than SHA-256 because a fast hash lets an attacker test
 * candidate secrets at memory bandwidth. Argon2 is deliberately slow and
 * memory-hard, which is the property that matters here.
 */
export function parseApiKey(raw: string): ApiKeyParts | null {
  const parts = raw.split("_");
  if (parts.length !== 3 || parts[0] !== "kori") return null;
  const [, prefix, secret] = parts as [string, string, string];
  if (!prefix || !secret) return null;
  return { prefix, secret };
}

export function generateApiKey(): { key: string; prefix: string; secret: string } {
  const prefix = randomUUID().replace(/-/g, "").slice(0, 12);
  const secret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  return { key: `kori_${prefix}_${secret}`, prefix, secret };
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

/**
 * Authenticate a request by API key or bearer token.
 *
 * Both paths end in the same place: `req.auth` with a subject and a set of
 * scopes. Routes then care about scopes and not about how the caller proved
 * who they are.
 */
export function authenticate(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header("authorization");
      if (!header) throw ApiError.unauthorized("an Authorization header is required");

      const [scheme, credential] = header.split(" ");
      if (!scheme || !credential) throw ApiError.unauthorized("malformed Authorization header");

      if (scheme.toLowerCase() === "bearer") {
        req.auth = verifyToken(credential);
        return next();
      }

      if (scheme.toLowerCase() === "apikey") {
        req.auth = await verifyApiKey(credential);
        return next();
      }

      throw ApiError.unauthorized(`unsupported authorization scheme: ${scheme}`);
    } catch (error) {
      next(error);
    }
  };
}

function verifyToken(token: string): { subject: string; scopes: string[] } {
  try {
    const cfg = config();
    const payload = jwt.verify(token, cfg.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub) {
      throw ApiError.unauthorized("token has no subject");
    }
    const scopes = Array.isArray((payload as { scopes?: unknown }).scopes)
      ? ((payload as { scopes: unknown[] }).scopes.filter((s) => typeof s === "string") as string[])
      : [];
    return { subject: payload.sub, scopes };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // The reason a token failed is not the client's business: distinguishing
    // "expired" from "bad signature" tells an attacker which half of a forged
    // token to keep working on.
    throw ApiError.unauthorized("invalid or expired token");
  }
}

async function verifyApiKey(raw: string): Promise<{ subject: string; scopes: string[] }> {
  const parsed = parseApiKey(raw);
  if (!parsed) throw ApiError.unauthorized("malformed API key");

  const { rows } = await query<{
    id: string;
    secret_hash: string;
    scopes: string[];
    revoked_at: Date | null;
  }>("SELECT id, secret_hash, scopes, revoked_at FROM api_keys WHERE prefix = $1", [parsed.prefix]);

  const record = rows[0];

  // Verify against a dummy hash when the prefix is unknown, so that a request
  // with a bad prefix takes the same time as one with a bad secret. Returning
  // early would turn response time into an oracle for which prefixes exist.
  if (!record) {
    await argon2.verify(DUMMY_HASH, "not-the-secret").catch(() => false);
    throw ApiError.unauthorized("invalid API key");
  }

  const ok = await argon2.verify(record.secret_hash, parsed.secret).catch(() => false);
  if (!ok) throw ApiError.unauthorized("invalid API key");
  if (record.revoked_at) throw ApiError.unauthorized("API key has been revoked");

  // Fire-and-forget: last_used_at is useful for spotting dormant keys and is
  // not worth failing a request over.
  void query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [record.id]).catch(() => {});

  return { subject: `apikey:${parsed.prefix}`, scopes: record.scopes };
}

// A precomputed Argon2id hash, used only to burn the same time as a real
// verification when the prefix does not exist.
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$K7bBVMxCKWFmC0kZHkzKKvHiPCwKZBqHkXlY0aGSCLc";

export function requireScope(...required: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(ApiError.unauthorized());
    // A wildcard scope exists so that an administrative key does not have to
    // enumerate every permission the system will ever have.
    if (req.auth.scopes.includes("*")) return next();
    const missing = required.filter((scope) => !req.auth!.scopes.includes(scope));
    if (missing.length > 0) {
      return next(ApiError.forbidden(`missing scope(s): ${missing.join(", ")}`));
    }
    next();
  };
}

/** Constant-time comparison, for anything secret compared outside Argon2. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Enforce idempotency on a mutating route.
 *
 * The middleware claims the key before the handler runs and records the
 * response after. The handler itself is written as though retries do not
 * exist, which is the point: the guarantee is structural rather than something
 * every endpoint has to remember.
 */
export function idempotent(options: { required?: boolean } = {}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("idempotency-key");

    if (!key) {
      if (options.required) {
        return next(
          ApiError.badRequest(
            "idempotency_key_required",
            "this endpoint moves money and requires an Idempotency-Key header",
          ),
        );
      }
      return next();
    }

    if (key.length > 255) {
      return next(
        ApiError.badRequest("idempotency_key_invalid", "Idempotency-Key must be 255 characters or fewer"),
      );
    }

    const cfg = config();
    const owner = req.auth?.subject ?? "anonymous";
    const requestHash = hashRequest(req.method, req.path, req.body);

    let claim;
    try {
      claim = await withTransaction((db) =>
        claimKey(db, key, owner, requestHash, cfg.IDEMPOTENCY_TTL_SECONDS),
      );
    } catch (error) {
      return next(error);
    }

    if (claim.outcome === "replay") {
      res.setHeader("idempotent-replay", "true");
      res.status(claim.response.status).json(claim.response.body);
      return;
    }

    if (claim.outcome === "in_progress") {
      return next(
        ApiError.conflict(
          "idempotency_key_in_progress",
          "a request with this Idempotency-Key is still being processed; retry shortly",
        ),
      );
    }

    if (claim.outcome === "conflict") {
      return next(
        ApiError.conflict(
          "idempotency_key_reused",
          "this Idempotency-Key was already used with a different request body",
        ),
      );
    }

    // Claimed. Capture whatever the handler sends so it can be replayed.
    const originalJson = res.json.bind(res);
    let settled = false;

    res.json = (body: unknown) => {
      if (settled) return res;
      settled = true;

      const status = res.statusCode;

      if (status >= 200 && status < 300) {
        // Record the success. If this write fails the client still gets its
        // response; the key expires on its own and a retry redoes the work,
        // which is the safe direction to fail in.
        void withTransaction((db) => completeKey(db, key, owner, { status, body }))
          .catch((error) => req.log?.error({ err: error }, "failed to record idempotency result"));
      } else {
        // A failed request must not leave its key claimed, or the retry would
        // be told "in progress" forever and the failure would become permanent.
        void withTransaction((db) => releaseKey(db, key, owner))
          .catch((error) => req.log?.error({ err: error }, "failed to release idempotency key"));
      }

      return originalJson(body);
    };

    // The handler may also fail by throwing, in which case res.json is never
    // called and the key would stay claimed.
    res.on("close", () => {
      if (!settled) {
        settled = true;
        void withTransaction((db) => releaseKey(db, key, owner)).catch(() => {});
      }
    });

    next();
  };
}
