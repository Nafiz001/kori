import { type Request, Router } from "express";
import { z } from "zod";

import { withTransaction } from "../db/pool.js";
import {
  type PostingLine,
  createAccount,
  getAccountByHandle,
  getTransfer,
  getTransferByReference,
  listAccounts,
  listEntries,
  postTransfer,
  reverseTransfer,
} from "../ledger/ledger.js";
import { verifyLedger } from "../ledger/verify.js";
import { CURRENCIES, isCurrencyCode, parseAmount, toJSON } from "../money/money.js";
import { ApiError } from "./errors.js";
import { idempotent, requireScope } from "./middleware.js";

/**
 * The API.
 *
 * Every body is validated with a schema before it reaches any logic, so a
 * handler can rely on its input having the shape it declares. Validation at the
 * edge rather than sprinkled through the code is what keeps `any` out of the
 * interior.
 */

const currencyCode = z.string().refine(isCurrencyCode, {
  message: `currency must be one of ${Object.keys(CURRENCIES).join(", ")}`,
});

// Amounts arrive as decimal strings, never as JSON numbers. A JSON number is a
// double in every mainstream parser, so "12.34" survives the trip and 12.34
// might not.
const amountString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "amount must be a decimal string such as \"12.34\"");

const handle = z.string().min(1).max(200);

/**
 * Read a route parameter.
 *
 * Express 5 types params as `string | string[]`, because a repeated wildcard
 * can match more than once. None of kori's routes have one, so anything other
 * than a plain string is a malformed URL rather than something to guess about.
 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") {
    throw ApiError.badRequest("invalid_path", `the ${name} path segment is malformed`);
  }
  return value;
}

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ApiError.badRequest("validation_failed", "the request body is not valid", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function buildRoutes(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  const createAccountBody = z.object({
    handle,
    name: z.string().min(1).max(200),
    currency: currencyCode,
    kind: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
    allowNegative: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  router.post("/accounts", requireScope("accounts:write"), async (req, res, next) => {
    try {
      const body = parseBody(createAccountBody, req.body);
      const account = await withTransaction((db) =>
        createAccount(db, {
          handle: body.handle,
          name: body.name,
          currency: body.currency,
          kind: body.kind,
          ...(body.allowNegative !== undefined ? { allowNegative: body.allowNegative } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        }),
      );
      res.status(201).json(serializeAccount(account));
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts", requireScope("accounts:read"), async (req, res, next) => {
    try {
      const limit = clampInt(req.query.limit, 100, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const accounts = await withTransaction((db) => listAccounts(db, limit, offset));
      res.json({ accounts: accounts.map(serializeAccount) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts/:handle", requireScope("accounts:read"), async (req, res, next) => {
    try {
      const account = await withTransaction((db) => getAccountByHandle(db, param(req, "handle")));
      if (!account) throw ApiError.notFound(`no account with handle ${param(req, "handle")}`);
      res.json(serializeAccount(account));
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts/:handle/entries", requireScope("accounts:read"), async (req, res, next) => {
    try {
      const limit = clampInt(req.query.limit, 50, 1, 500);
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      const entries = await withTransaction((db) =>
        listEntries(db, param(req, "handle"), limit, before),
      );
      res.json({
        entries: entries.map((entry) => ({
          id: entry.id,
          transferId: entry.transferId,
          amount: toJSON(entry.amount),
          balanceAfter: toJSON(entry.balanceAfter),
          createdAt: entry.createdAt.toISOString(),
        })),
        // Cursor pagination rather than offset: an offset shifts under
        // concurrent inserts, so a client paging through a busy account would
        // see rows twice or miss them entirely.
        nextCursor: entries.length === limit ? entries[entries.length - 1]!.id : null,
      });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  const transferBody = z.object({
    currency: currencyCode,
    lines: z
      .array(z.object({ account: handle, amount: amountString }))
      .min(2, "a transfer needs at least two lines"),
    kind: z.enum(["transfer", "deposit", "withdrawal", "fee", "adjustment"]).optional(),
    reference: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  router.post(
    "/transfers",
    requireScope("transfers:write"),
    // Required, not optional. This endpoint moves money, and a client that
    // retries without a key will move it twice.
    idempotent({ required: true }),
    async (req, res, next) => {
      try {
        const body = parseBody(transferBody, req.body);

        const lines: PostingLine[] = body.lines.map((line) => ({
          accountHandle: line.account,
          amount: parseAmount(body.currency, line.amount),
        }));

        const transfer = await withTransaction((db) =>
          postTransfer(db, {
            lines,
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.reference !== undefined ? { reference: body.reference } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          }),
        );

        res.status(201).json(serializeTransfer(transfer));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/transfers/:id", requireScope("transfers:read"), async (req, res, next) => {
    try {
      const transfer = await withTransaction((db) => getTransfer(db, param(req, "id")));
      if (!transfer) throw ApiError.notFound(`no transfer with id ${param(req, "id")}`);
      res.json(serializeTransfer(transfer));
    } catch (error) {
      next(error);
    }
  });

  // Lookup by the caller's own reference, which is how a client that lost our
  // id after a timeout finds out whether its transfer went through.
  router.get("/transfers", requireScope("transfers:read"), async (req, res, next) => {
    try {
      const reference = req.query.reference;
      if (typeof reference !== "string") {
        throw ApiError.badRequest("reference_required", "a reference query parameter is required");
      }
      const transfer = await withTransaction((db) => getTransferByReference(db, reference));
      if (!transfer) throw ApiError.notFound(`no transfer with reference ${reference}`);
      res.json(serializeTransfer(transfer));
    } catch (error) {
      next(error);
    }
  });

  const reversalBody = z.object({ description: z.string().max(1000).optional() });

  router.post(
    "/transfers/:id/reversal",
    requireScope("transfers:write"),
    idempotent({ required: true }),
    async (req, res, next) => {
      try {
        const body = parseBody(reversalBody, req.body ?? {});
        const reversal = await withTransaction((db) =>
          reverseTransfer(db, param(req, "id"), body.description),
        );
        res.status(201).json(serializeTransfer(reversal));
      } catch (error) {
        next(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  // Re-derive the ledger and report any disagreement. Exposed over HTTP so it
  // can be scraped or alerted on, not only run by hand.
  router.get("/verify", requireScope("admin"), async (_req, res, next) => {
    try {
      const report = await withTransaction((db) => verifyLedger(db));
      res.status(report.ok ? 200 : 500).json(report);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeAccount(account: {
  handle: string;
  name: string;
  currency: string;
  kind: string;
  balance: Parameters<typeof toJSON>[0];
  allowNegative: boolean;
  frozen: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
}) {
  return {
    handle: account.handle,
    name: account.name,
    currency: account.currency,
    kind: account.kind,
    balance: toJSON(account.balance),
    allowNegative: account.allowNegative,
    frozen: account.frozen,
    metadata: account.metadata,
    createdAt: account.createdAt.toISOString(),
  };
}

function serializeTransfer(transfer: {
  id: string;
  reference: string | null;
  kind: string;
  currency: string;
  status: string;
  reverses: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  entries: Array<{
    id: string;
    accountHandle: string;
    amount: Parameters<typeof toJSON>[0];
    balanceAfter: Parameters<typeof toJSON>[0];
  }>;
}) {
  return {
    id: transfer.id,
    reference: transfer.reference,
    kind: transfer.kind,
    currency: transfer.currency,
    status: transfer.status,
    reverses: transfer.reverses,
    description: transfer.description,
    metadata: transfer.metadata,
    createdAt: transfer.createdAt.toISOString(),
    lines: transfer.entries.map((entry) => ({
      entryId: entry.id,
      account: entry.accountHandle,
      amount: toJSON(entry.amount),
      balanceAfter: toJSON(entry.balanceAfter),
    })),
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
