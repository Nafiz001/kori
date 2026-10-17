# kori

A double-entry ledger and payments API, in TypeScript and PostgreSQL.

কড়ি — the cowrie shells used as currency in old Bengal.

kori moves money between accounts and refuses to lose any. Every movement is a
balanced transaction, the journal is append-only, and a verification pass
re-derives every balance from that journal to prove nothing has drifted.

```console
$ npm run demo

3. Customer pays 1500.00, platform keeps 2.5%
  ----------------------------------------------------
  bank                 -2000.00 BDT   (equity)
  customer               500.00 BDT   (liability)
  merchant              1462.50 BDT   (liability)
  platform-fees           37.50 BDT   (revenue)
  ----------------------------------------------------
  sum of all               0.00 BDT

6. Verification: 114 accounts and 496 transfers re-derived from the journal in 8ms
   every cached balance matches the journal, and all entries sum to zero
```

That last line is the whole design. The sum of every account is zero, always,
because money is never created or destroyed by a double-entry system — only
moved.

## The problems it solves

A payments API is mostly not about payments. It is about four failure modes
that ordinary CRUD never has to face, and each one is handled somewhere
specific in this codebase.

### 1. Money is not a float

`0.1 + 0.2 === 0.30000000000000004`. In a ledger that means a sequence of
correct-looking operations leaves the books off by a fraction of a poisha, and
the discrepancy compounds silently until someone reconciles by hand.

kori holds amounts as **integer minor units in a `bigint`** — poisha, not taka.
Amounts are parsed from *strings*, never from JSON numbers, because accepting
`12.34` as a number means the value already went through a double before kori
ever saw it. The API rejects a numeric amount outright.

Currency scale is data rather than a hardcoded 100: BDT and USD have two decimal
places, JPY has none, KWD has three. Splitting 1.00 three ways gives 0.34, 0.33,
0.33 — never three lots of 0.33 that quietly discard a poisha.

### 2. Concurrent transfers must not lose or invent money

Two overlapping withdrawals both read a balance of 100, both decide 80 is
affordable, and both proceed. No single request was wrong.

kori locks every account a transfer touches with `SELECT ... FOR UPDATE`, **in
sorted handle order**. The sort is what makes it deadlock-free: if one
transaction locks A then B while another locks B then A, both wait forever.
Sorting means every transaction in the system takes locks in the same sequence,
so a cycle cannot form.

There is a test that fires twenty concurrent withdrawals of 1.00 at an account
holding 10.00 and asserts that exactly ten succeed.

### 3. A retried request must not pay twice

A client that times out does not know whether its request applied. The only safe
thing it can do is retry.

Every endpoint that moves money **requires** an `Idempotency-Key`. The key is
claimed before the handler runs and the response recorded after, so handlers are
written as though retries do not exist. Twelve concurrent copies of the same
request produce exactly one transfer, and the test asserts it.

### 4. An event must not exist without the money having moved

Commit-then-publish loses the event if the process dies in between. Publish-then-
commit announces a transfer that never happened.

kori writes the event into the **same database transaction** as the entries, so
"the money moved" and "an event exists saying so" are one atomic fact. A separate
worker publishes from that table. Delivery is at-least-once and the code says so
rather than pretending otherwise.

## Quick start

```sh
git clone https://github.com/Nafiz001/kori
cd kori
npm install
docker compose up -d          # PostgreSQL and Redis
cp .env.example .env          # then set JWT_SECRET
npm run migrate
npm run demo                  # the worked example above
npm run dev                   # the API on :3000
```

```sh
npm test          # 86 tests against real PostgreSQL and Redis
npm run verify    # re-derive every balance from the journal
npm run apikey -- "my key" "*"
```

## The API

```
POST   /v1/accounts                    create an account
GET    /v1/accounts                    list accounts
GET    /v1/accounts/:handle            one account and its balance
GET    /v1/accounts/:handle/entries    statement, cursor-paginated

POST   /v1/transfers                   move money            (Idempotency-Key required)
GET    /v1/transfers/:id               one transfer
GET    /v1/transfers?reference=...     find by your own reference
POST   /v1/transfers/:id/reversal      reverse it            (Idempotency-Key required)

GET    /v1/verify                      re-derive the ledger and report drift

GET    /health/live                    liveness
GET    /health/ready                   readiness
GET    /metrics                        Prometheus exposition
```

A transfer is a list of lines that must sum to zero:

```sh
curl -X POST localhost:3000/v1/transfers \
  -H "authorization: ApiKey kori_..." \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{
    "currency": "BDT",
    "reference": "order-4711",
    "lines": [
      { "account": "user:alice/wallet", "amount": "-1500.00" },
      { "account": "merchant:shop/wallet", "amount": "1462.50" },
      { "account": "platform:fees", "amount": "37.50" }
    ]
  }'
```

Three lines, one transaction. The fee cannot exist without the payment, and one
atomic movement makes that structural rather than a convention.

Errors are one shape everywhere, with a machine-readable code:

```json
{ "error": { "code": "insufficient_funds", "message": "...", "requestId": "..." } }
```

**Insufficient funds is 422, not 400.** The request was well-formed and the
client did nothing wrong — the account simply does not hold enough. A 400 would
tell the client to fix a request that was fine.

## How it works

### The schema enforces the invariant, not just the application

Every transfer's entries must sum to zero. That is checked in the application
*and* by PostgreSQL, with a constraint trigger:

```sql
CREATE CONSTRAINT TRIGGER entries_must_balance
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  ...
```

`DEFERRABLE INITIALLY DEFERRED` is what makes it possible. Entries are inserted
one row at a time, so the books are legitimately unbalanced in the middle of the
transaction, and a per-statement check would reject every valid transfer.
Checking at `COMMIT` asks the only question that matters: were they balanced by
the time anyone else could see them?

A second trigger makes entries immutable. There is no `UPDATE` or `DELETE` path
to the journal anywhere. A mistake is corrected by posting a **reversing
transfer**, which is what keeps the journal an audit trail rather than merely a
table — the history says money moved and then moved back, because that is what
happened.

An invariant that lives in one language is one refactor away from being lost.

### Balances are a cache, and the cache is checked

`accounts.balance` is derived data; the truth is `SUM(entries.amount)`. It is
cached because summing an account's whole history on every read does not survive
real volume.

Every optimisation is a chance for two things that should agree to stop
agreeing, so `npm run verify` re-derives all of it: every cached balance against
the journal, every transfer summed to zero, every currency's entries summed to
zero across the entire ledger, and no unauthorised negative balance. A test
deliberately corrupts a balance and asserts the check catches it — a check that
has never been seen to fail is not known to work.

### Layout

```
src/money/money.ts        amounts, currencies, allocation, rates
src/db/pool.ts            pool, transactions, bigint parsing
src/db/migrations/        forward-only SQL
src/ledger/ledger.ts      accounts, posting, reversal — the core
src/ledger/verify.ts      re-derive and compare
src/idempotency/store.ts  claim, replay, release
src/outbox/outbox.ts      transactional outbox
src/http/                 app, routes, auth, rate limiting, errors
src/observability/        structured logs, Prometheus metrics
src/worker.ts             the outbox publisher
```

Raw SQL, no ORM. For a ledger that is a feature: the locking, the `ON CONFLICT`,
the `FOR UPDATE SKIP LOCKED` in the outbox and the deferred trigger are all
things an ORM would abstract away exactly where the abstraction is wrong.

### Choices worth defending

**Idempotency records live in PostgreSQL; rate-limit counters live in Redis.**
Opposite choices for opposite reasons. A lost idempotency record lets a payment
happen twice. A lost rate-limit counter lets someone make a few extra requests.
The durable store guards the first and the fast one guards the second, and the
rate limiter deliberately **fails open** — refusing every payment because a
cache is down converts a minor outage into a total one.

**Liveness does not touch the database; readiness does.** A liveness probe that
checked the database would make a database blip restart every healthy instance,
turning a partial outage into a total one. Readiness takes an instance out of
the load balancer instead, which is the correct response to "cannot reach the
database".

**A 500 never forwards the underlying message.** An unexpected error can carry a
connection string, a query, or a fragment of someone else's data. The request id
ties the vague answer to the detailed log line.

**Argon2id for API key secrets, with the prefix stored in clear.** The prefix
lets a key be identified in a list or an audit log; the hash means a leaked
database yields no working credentials. A fast hash like SHA-256 would let an
attacker test candidates at memory bandwidth. An unknown prefix still runs a
verification against a dummy hash, so response time does not become an oracle
for which prefixes exist.

**Latency is a histogram, not an average.** A mean of 40 ms is consistent with
every request taking 40 ms and with 99% taking 5 ms while 1% take 4 seconds.
Only the second is an incident.

## Testing

86 tests against **real PostgreSQL and Redis**, in Docker. Nothing is mocked,
and that is deliberate: every claim kori makes — the deferred trigger,
`FOR UPDATE`, `ON CONFLICT`, the deadlock ordering — is a claim about how
PostgreSQL behaves, and a mock would simply agree with whatever the code did.

| Suite | What it covers |
|---|---|
| `money.test.ts` | exactness, currency scales, allocation losing nothing, rounding |
| `ledger.test.ts` | posting, rejections, reversal, the database-level invariants |
| `concurrency.test.ts` | lost updates, overdraft under contention, deadlock avoidance |
| `api.test.ts` | auth, scopes, validation, idempotency, the outbox, observability |

The API tests drive the assembled Express app in-process with supertest, so the
whole middleware chain runs. Testing handlers directly would skip exactly the
parts most likely to be wrong.

### Bugs the tests actually caught

Worth recording, because these are the ones that would otherwise have shipped.

- **`SUM(bigint)` returns `numeric` in PostgreSQL.** The pool parses `numeric`
  as a string rather than risk a double, so the verification pass was
  *concatenating* text where it meant to subtract. Every drift check silently
  compared nonsense until the sums were cast back to `bigint`.
- **An error inside a transaction aborts it.** `claimKey` caught the unique
  violation from its `INSERT` and then read the existing row to decide replay
  versus conflict. That read can never run — every command after an error fails
  with `25P02` until the transaction ends. Fixed with `ON CONFLICT DO NOTHING`,
  which never produces the error at all.
- **`Promise.all` over one pooled client.** A connection runs one query at a
  time; issuing two together does not parallelise anything, it queues them
  behind a deprecation warning and will throw in `pg@9`.
- **A test that poisoned every later run.** The drift test deliberately corrupts
  a balance, and did not restore it when an assertion failed — so every
  subsequent whole-ledger check failed for a reason unrelated to the code.

### What removing the lock actually does

Worth stating precisely, because the result was not what I assumed. Deleting
`FOR UPDATE` and re-running the concurrency suite fails **one** assertion, and
not the one about money.

Money is still not lost: the balance is updated with `balance = balance + delta`,
which PostgreSQL applies atomically, and the `CHECK` constraint refuses a
negative result. What breaks is the *diagnosis* — the affordability check reads
a stale balance, lets a doomed transfer through, and the client receives a raw
constraint violation instead of being told it has insufficient funds.

So the lock makes the error correct, and the constraint makes the ledger safe
even if the lock were ever lost. The test asserts the error code for exactly
this reason.

## Limits

Stated rather than hidden.

- **Single currency per transfer.** A cross-currency movement is two transfers
  joined by an exchange account, so each set of books balances on its own.
  Summing taka and dollars to one zero would be meaningless. No FX rates.
- **Balances are locked per account, so a hot account serialises.** Every
  transfer touching it waits. Real systems shard a hot account into buckets that
  are summed on read; kori does not, and at BDT-market volumes would not need to
  for a long time.
- **Migrations run at startup.** Right for a single instance. With several
  starting at once they race, and PostgreSQL's transactional DDL means the
  losers fail rather than corrupt anything — but past one instance this belongs
  in a job that runs before the rollout.
- **The outbox publisher writes to the log.** Substituting Kafka, SQS or a
  webhook is a change to one function; the delivery guarantee lives in the table
  and the claim query, not in the transport.
- **Fixed-window rate limiting.** A client can burst a full allowance at
  11:59:59 and another at 12:00:00. A sliding log would fix it at the cost of
  storing every timestamp; for protecting a service from a runaway client the
  burst is acceptable.
- **No double-entry *reporting*.** Trial balances, period closing and P&L
  statements are what an accounting system builds on top of a ledger like this,
  and none of it is here.
- **No user-facing auth.** API keys and signed tokens, no registration, no
  passwords, no sessions. kori is a service other services call.

## Stack

Node 22, TypeScript in strict mode, Express 5, PostgreSQL 16, Redis 7, Zod,
Vitest, Docker. No ORM.

## License

MIT
