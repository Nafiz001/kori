import { randomUUID } from "node:crypto";

import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, withTransaction } from "../src/db/pool.js";
import { buildApp } from "../src/http/app.js";
import { closeRedis } from "../src/http/rateLimit.js";
import { generateApiKey, hashSecret } from "../src/http/middleware.js";
import { getPool } from "../src/db/pool.js";
import { drainOnce } from "../src/worker.js";
import { balanceOf, ensureSchema, makeAccount, uniqueHandle } from "./helpers.js";

/**
 * API tests.
 *
 * These drive the assembled Express app in-process with supertest, so the whole
 * middleware chain runs: authentication, validation, idempotency, rate limiting
 * and error mapping. Testing the handlers directly would skip exactly the parts
 * most likely to be wrong.
 */

let app: Express;

function tokenFor(scopes: string[], subject = `test-${randomUUID().slice(0, 8)}`): string {
  return jwt.sign({ sub: subject, scopes }, process.env.JWT_SECRET!, { expiresIn: "10m" });
}

const admin = () => tokenFor(["*"]);

beforeAll(async () => {
  await ensureSchema();
  app = buildApp();
});

afterAll(async () => {
  await closePool();
  await closeRedis();
});

describe("authentication", () => {
  it("refuses a request with no Authorization header", async () => {
    const res = await request(app).get("/v1/accounts");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("refuses a malformed or forged token", async () => {
    for (const header of ["Bearer nonsense", "Bearer ", "Basic abc", "nonsense"]) {
      const res = await request(app).get("/v1/accounts").set("authorization", header);
      expect(res.status, header).toBe(401);
    }
  });

  it("refuses a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: "attacker", scopes: ["*"] }, "not-the-real-secret-at-all-x");
    const res = await request(app).get("/v1/accounts").set("authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("does not say why a token was rejected", async () => {
    // Distinguishing "expired" from "bad signature" tells an attacker which
    // half of a forged token to keep working on.
    const expired = jwt.sign({ sub: "x", scopes: [] }, process.env.JWT_SECRET!, {
      expiresIn: "-1s",
    });
    const res = await request(app).get("/v1/accounts").set("authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("invalid or expired token");
  });

  it("enforces scopes", async () => {
    const readOnly = tokenFor(["accounts:read"]);

    const read = await request(app).get("/v1/accounts").set("authorization", `Bearer ${readOnly}`);
    expect(read.status).toBe(200);

    const write = await request(app)
      .post("/v1/accounts")
      .set("authorization", `Bearer ${readOnly}`)
      .send({ handle: uniqueHandle("nope"), name: "n", currency: "BDT", kind: "liability" });

    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("forbidden");
  });

  it("accepts an API key", async () => {
    const { key, prefix, secret } = generateApiKey();
    await getPool().query(
      "INSERT INTO api_keys (id, name, prefix, secret_hash, scopes) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), "test key", prefix, await hashSecret(secret), ["accounts:read"]],
    );

    const ok = await request(app).get("/v1/accounts").set("authorization", `ApiKey ${key}`);
    expect(ok.status).toBe(200);

    // The same prefix with the wrong secret must not work.
    const bad = await request(app)
      .get("/v1/accounts")
      .set("authorization", `ApiKey kori_${prefix}_wrongsecret`);
    expect(bad.status).toBe(401);
  });

  it("refuses a revoked API key", async () => {
    const { key, prefix, secret } = generateApiKey();
    await getPool().query(
      `INSERT INTO api_keys (id, name, prefix, secret_hash, scopes, revoked_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [randomUUID(), "revoked", prefix, await hashSecret(secret), ["*"]],
    );

    const res = await request(app).get("/v1/accounts").set("authorization", `ApiKey ${key}`);
    expect(res.status).toBe(401);
  });
});

describe("accounts", () => {
  it("creates and reads an account", async () => {
    const handle = uniqueHandle("api");
    const created = await request(app)
      .post("/v1/accounts")
      .set("authorization", `Bearer ${admin()}`)
      .send({ handle, name: "API account", currency: "BDT", kind: "liability" });

    expect(created.status).toBe(201);
    expect(created.body.handle).toBe(handle);
    expect(created.body.balance).toEqual({ currency: "BDT", amount: "0.00", minor: "0" });

    const read = await request(app)
      .get(`/v1/accounts/${encodeURIComponent(handle)}`)
      .set("authorization", `Bearer ${admin()}`);

    expect(read.status).toBe(200);
    expect(read.body.handle).toBe(handle);
  });

  it("rejects a duplicate handle", async () => {
    const handle = uniqueHandle("dup");
    const body = { handle, name: "n", currency: "BDT", kind: "liability" };

    await request(app).post("/v1/accounts").set("authorization", `Bearer ${admin()}`).send(body);
    const second = await request(app)
      .post("/v1/accounts")
      .set("authorization", `Bearer ${admin()}`)
      .send(body);

    expect(second.status).toBe(400);
  });

  it("validates the body and says what was wrong", async () => {
    const res = await request(app)
      .post("/v1/accounts")
      .set("authorization", `Bearer ${admin()}`)
      .send({ handle: "", currency: "XYZ", kind: "nonsense" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.details.issues.length).toBeGreaterThan(0);
    expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toContain("currency");
  });

  it("404s an unknown account", async () => {
    const res = await request(app)
      .get("/v1/accounts/nope:nothing")
      .set("authorization", `Bearer ${admin()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("transfers", () => {
  it("moves money and reports both sides", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const res = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-30.00" },
          { account: to, amount: "30.00" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.currency).toBe("BDT");

    const credited = res.body.lines.find((l: { account: string }) => l.account === to);
    expect(credited.amount.amount).toBe("30.00");
    expect(credited.balanceAfter.amount).toBe("30.00");

    expect(await balanceOf(to)).toBe(3000n);
  });

  it("requires an Idempotency-Key", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "10.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const res = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-1.00" },
          { account: to, amount: "1.00" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
    expect(await balanceOf(to)).toBe(0n);
  });

  it("reports insufficient funds as 422, not 400", async () => {
    // The request was well-formed and the client did nothing wrong; the account
    // simply does not hold enough. 400 would tell the client to fix its
    // request, which is the wrong advice.
    const from = await makeAccount(uniqueHandle("from"), { balance: "1.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const res = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-500.00" },
          { account: to, amount: "500.00" },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("insufficient_funds");
  });

  it("rejects an unbalanced transfer", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const res = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-10.00" },
          { account: to, amount: "9.99" },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("unbalanced");
  });

  it("rejects an amount that is a JSON number rather than a string", async () => {
    // Accepting 12.34 as a number would mean the value had already been through
    // a double before kori ever saw it.
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const res = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: -10.0 },
          { account: to, amount: 10.0 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_failed");
  });

  it("finds a transfer by the caller's own reference", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));
    const reference = uniqueHandle("order");

    const posted = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        reference,
        lines: [
          { account: from, amount: "-5.00" },
          { account: to, amount: "5.00" },
        ],
      });

    const found = await request(app)
      .get(`/v1/transfers?reference=${encodeURIComponent(reference)}`)
      .set("authorization", `Bearer ${admin()}`);

    expect(found.status).toBe(200);
    expect(found.body.id).toBe(posted.body.id);
  });

  it("reverses a transfer and refuses to do it twice", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const posted = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-40.00" },
          { account: to, amount: "40.00" },
        ],
      });

    const reversal = await request(app)
      .post(`/v1/transfers/${posted.body.id}/reversal`)
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({});

    expect(reversal.status).toBe(201);
    expect(await balanceOf(to)).toBe(0n);

    const again = await request(app)
      .post(`/v1/transfers/${posted.body.id}/reversal`)
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({});

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_reversed");
  });
});

describe("idempotency", () => {
  it("replays the original response instead of moving money twice", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));
    const key = randomUUID();

    // One token for both requests. admin() mints a fresh subject each call, and
    // idempotency keys are scoped per caller, so two tokens would be two
    // different owners and the key would not collide at all.
    const token = admin();

    const body = {
      currency: "BDT",
      lines: [
        { account: from, amount: "-25.00" },
        { account: to, amount: "25.00" },
      ],
    };

    const first = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send(body);

    const second = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers["idempotent-replay"]).toBe("true");

    // The money moved exactly once.
    expect(await balanceOf(to)).toBe(2500n);
  });

  it("moves money once when the same request arrives many times at once", async () => {
    // The real scenario: a client times out, retries, and both requests are in
    // flight together. The claim is an INSERT on a primary key, so exactly one
    // can win -- there is no read-then-write window for them to race in.
    const from = await makeAccount(uniqueHandle("from"), { balance: "1000.00" });
    const to = await makeAccount(uniqueHandle("to"));
    const key = randomUUID();
    const token = admin();

    const body = {
      currency: "BDT",
      lines: [
        { account: from, amount: "-10.00" },
        { account: to, amount: "10.00" },
      ],
    };

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app)
          .post("/v1/transfers")
          .set("authorization", `Bearer ${token}`)
          .set("idempotency-key", key)
          .send(body),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const inProgress = responses.filter((r) => r.status === 409);

    expect(created.length + inProgress.length).toBe(12);
    expect(created.length).toBeGreaterThanOrEqual(1);

    // Whatever the interleaving, the transfer happened once.
    expect(await balanceOf(to)).toBe(1000n);

    const ids = new Set(created.map((r) => r.body.id));
    expect(ids.size).toBe(1);
  });

  it("reports a conflict when a key is reused with a different body", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));
    const key = randomUUID();
    const token = admin();

    await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-1.00" },
          { account: to, amount: "1.00" },
        ],
      });

    const different = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-99.00" },
          { account: to, amount: "99.00" },
        ],
      });

    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("idempotency_key_reused");
    expect(await balanceOf(to)).toBe(100n);
  });

  it("frees the key when the request failed, so a retry can succeed", async () => {
    // A rejected request must not leave its key claimed, or the retry would be
    // told "in progress" forever and the failure would become permanent.
    const from = await makeAccount(uniqueHandle("from"), { balance: "5.00" });
    const to = await makeAccount(uniqueHandle("to"));
    const key = randomUUID();
    const token = admin();

    const tooMuch = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-500.00" },
          { account: to, amount: "500.00" },
        ],
      });

    expect(tooMuch.status).toBe(422);

    // Same key, an affordable amount this time. It must go through.
    const affordable = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", key)
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-1.00" },
          { account: to, amount: "1.00" },
        ],
      });

    expect(affordable.status).toBe(201);
    expect(await balanceOf(to)).toBe(100n);
  });

  it("scopes keys per caller", async () => {
    // Two API consumers both choosing the idempotency key "1" -- which somebody
    // will -- must not see each other's responses.
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const body = {
      currency: "BDT",
      lines: [
        { account: from, amount: "-5.00" },
        { account: to, amount: "5.00" },
      ],
    };

    const alice = tokenFor(["*"], "alice");
    const bob = tokenFor(["*"], "bob");

    const a = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${alice}`)
      .set("idempotency-key", "shared-key-1")
      .send(body);

    const b = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${bob}`)
      .set("idempotency-key", "shared-key-1")
      .send(body);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await balanceOf(to)).toBe(1000n);
  });
});

describe("the outbox", () => {
  it("writes an event in the same transaction as the transfer", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const posted = await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-15.00" },
          { account: to, amount: "15.00" },
        ],
      });

    const { rows } = await getPool().query<{ topic: string; payload: Record<string, unknown> }>(
      "SELECT topic, payload FROM outbox WHERE aggregate_id = $1",
      [posted.body.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.topic).toBe("transfer.posted");
    expect(rows[0]!.payload.transferId).toBe(posted.body.id);
  });

  it("does not write an event for a transfer that was rejected", async () => {
    // The whole point of the outbox: the event and the money are one atomic
    // fact, so a rolled-back transfer leaves no event behind.
    const from = await makeAccount(uniqueHandle("from"), { balance: "1.00" });
    const to = await makeAccount(uniqueHandle("to"));

    const before = await getPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM outbox",
    );

    await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-999.00" },
          { account: to, amount: "999.00" },
        ],
      });

    const after = await getPool().query<{ n: string }>("SELECT count(*)::text AS n FROM outbox");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("publishes pending events and marks them done", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-7.00" },
          { account: to, amount: "7.00" },
        ],
      });

    const published: string[] = [];
    let handled = 0;
    do {
      handled = await drainOnce({ publish: async (e) => void published.push(e.topic) });
    } while (handled > 0);

    expect(published.length).toBeGreaterThan(0);

    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM outbox WHERE published_at IS NULL",
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("retries an event whose publish failed rather than losing it", async () => {
    const from = await makeAccount(uniqueHandle("from"), { balance: "100.00" });
    const to = await makeAccount(uniqueHandle("to"));

    // Drain whatever is already queued so this test sees only its own event.
    while ((await drainOnce()) > 0) {
      /* drain */
    }

    await request(app)
      .post("/v1/transfers")
      .set("authorization", `Bearer ${admin()}`)
      .set("idempotency-key", randomUUID())
      .send({
        currency: "BDT",
        lines: [
          { account: from, amount: "-3.00" },
          { account: to, amount: "3.00" },
        ],
      });

    const handled = await drainOnce({
      publish: async () => {
        throw new Error("consumer is down");
      },
    });
    expect(handled).toBe(1);

    // Still pending, with the failure recorded and a retry scheduled.
    const { rows } = await getPool().query<{
      attempts: number;
      last_error: string;
      published_at: Date | null;
    }>("SELECT attempts, last_error, published_at FROM outbox ORDER BY id DESC LIMIT 1");

    expect(rows[0]!.published_at).toBeNull();
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toContain("consumer is down");
  });
});

describe("operations", () => {
  it("reports liveness without touching the database", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("reports readiness by checking the database", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("exposes metrics in Prometheus format", async () => {
    await request(app).get("/health/live");

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("kori_http_requests_total");
    expect(res.text).toContain("kori_http_request_duration_ms_bucket");
    expect(res.text).toContain("kori_process_uptime_seconds");
  });

  it("verifies the ledger over HTTP", async () => {
    const res = await request(app).get("/v1/verify").set("authorization", `Bearer ${admin()}`);
    if (res.status !== 200) console.error(res.body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("echoes a request id, and generates one when none is given", async () => {
    const given = await request(app).get("/health/live").set("x-request-id", "trace-abc");
    expect(given.headers["x-request-id"]).toBe("trace-abc");

    const generated = await request(app).get("/health/live");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("404s an unknown route in the standard error shape", async () => {
    const res = await request(app).get("/v1/nothing-here").set("authorization", `Bearer ${admin()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect(res.body.error.requestId).toBeDefined();
  });

  it("never leaks an internal message on a 500", async () => {
    // Verified indirectly: the error mapper is the only path to a 500 body, and
    // it substitutes a fixed message rather than forwarding the error.
    const { toErrorResponse } = await import("../src/http/errors.js");
    const mapped = toErrorResponse(new Error("connection to postgres://user:hunter2@db failed"));

    expect(mapped.status).toBe(500);
    expect(mapped.body.error.message).toBe("an unexpected error occurred");
    expect(JSON.stringify(mapped.body)).not.toContain("hunter2");
  });
});

describe("rate limiting", () => {
  it("limits a caller and says when to retry", async () => {
    const token = tokenFor(["accounts:read"], `rl-${randomUUID().slice(0, 8)}`);

    // The configured limit is well above this, so drive a small explicit one.
    const { consume } = await import("../src/http/rateLimit.js");
    const identity = `manual-${randomUUID().slice(0, 8)}`;

    let last = await consume(identity, 3);
    expect(last.allowed).toBe(true);
    last = await consume(identity, 3);
    last = await consume(identity, 3);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);

    last = await consume(identity, 3);
    expect(last.allowed).toBe(false);
    expect(last.resetSeconds).toBeGreaterThan(0);

    // And the middleware surfaces headers on a normal request.
    const res = await request(app).get("/v1/accounts").set("authorization", `Bearer ${token}`);
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });
});
