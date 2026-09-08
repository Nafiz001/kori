import type { NextFunction, Request, Response } from "express";

import { LedgerError, type LedgerErrorCode } from "../ledger/ledger.js";
import { MoneyError } from "../money/money.js";

/**
 * Errors, and the single place they become HTTP responses.
 *
 * Every error leaves the API in the same shape, so a client can write one
 * handler instead of one per endpoint:
 *
 *   { "error": { "code": "insufficient_funds", "message": "...", "details": {} } }
 *
 * A machine-readable `code` matters more than the message. The message is for a
 * human reading a log; the code is what a client branches on, and it is stable
 * in a way prose is not.
 */

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = "authentication required"): ApiError {
    return new ApiError(401, "unauthorized", message);
  }

  static forbidden(message = "insufficient scope"): ApiError {
    return new ApiError(403, "forbidden", message);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, "not_found", message);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(409, code, message, details);
  }

  static tooManyRequests(message: string, retryAfter: number): ApiError {
    return new ApiError(429, "rate_limited", message, { retryAfterSeconds: retryAfter });
  }
}

/**
 * Which HTTP status each ledger failure deserves.
 *
 * Spelled out as a table rather than decided at each throw site, so that the
 * same condition cannot be a 400 in one endpoint and a 409 in another.
 *
 * The distinction worth defending: insufficient funds is 422, not 400. The
 * request was well-formed and the client did nothing wrong -- the account
 * simply does not hold enough. 400 would tell a client to fix its request,
 * which is the wrong advice.
 */
const LEDGER_STATUS: Record<LedgerErrorCode, number> = {
  account_not_found: 404,
  transfer_not_found: 404,
  account_frozen: 422,
  insufficient_funds: 422,
  currency_mismatch: 422,
  unbalanced: 422,
  duplicate_reference: 409,
  already_reversed: 409,
  invalid_request: 400,
};

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

export function toErrorResponse(
  error: unknown,
  requestId?: string,
): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  if (error instanceof LedgerError) {
    return {
      status: LEDGER_STATUS[error.code] ?? 422,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  if (error instanceof MoneyError) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid_amount",
          message: error.message,
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  // Anything else is a bug. The message is deliberately not forwarded: an
  // unexpected error can carry a connection string, a query, or a fragment of
  // someone else's data, and none of that belongs in a response. The request id
  // is what ties the vague answer to the detailed log line.
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "an unexpected error occurred",
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}

/** The Express error handler. Must take four arguments to be recognised as one. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = res.getHeader("x-request-id");
  const { status, body } = toErrorResponse(
    error,
    typeof requestId === "string" ? requestId : undefined,
  );

  if (status >= 500) {
    req.log?.error({ err: error }, "unhandled error");
  } else {
    req.log?.warn({ code: body.error.code, status }, body.error.message);
  }

  res.status(status).json(body);
}

/** A 404 for anything that matched no route, in the same shape as every other error. */
export function notFoundHandler(req: Request, res: Response): void {
  const requestId = res.getHeader("x-request-id");
  res.status(404).json({
    error: {
      code: "not_found",
      message: `no route for ${req.method} ${req.path}`,
      ...(typeof requestId === "string" ? { requestId } : {}),
    },
  } satisfies ErrorBody);
}
