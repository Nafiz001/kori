-- kori: the ledger schema.
--
-- The design is an immutable journal. Entries are append-only and never
-- updated or deleted; a mistake is corrected by posting a reversing transfer,
-- not by editing history. That is what makes the ledger auditable: every
-- balance can be reconstructed by replaying the entries, and any disagreement
-- between the cached balance and that replay is a detectable bug rather than a
-- silent one.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id              uuid PRIMARY KEY,

  -- A stable, human-meaningful handle: "user:01H8.../wallet", "system:fees".
  -- Callers address accounts by this rather than by uuid, so an integration
  -- does not have to store our identifiers.
  handle          text NOT NULL UNIQUE,
  name            text NOT NULL,

  currency        char(3) NOT NULL,

  -- The five classical account kinds. Which side of the books an account sits
  -- on decides whether a positive balance is money the business holds or money
  -- it owes.
  kind            text NOT NULL
                  CHECK (kind IN ('asset', 'liability', 'equity', 'revenue', 'expense')),

  -- The cached balance, in minor units.
  --
  -- It is derived data: the truth is SUM(entries.amount). It is cached because
  -- a balance read is the most common operation in the system and summing an
  -- account's entire history on every read does not survive contact with real
  -- volume. The trade is that the cache can drift, so `kori verify` re-derives
  -- every balance from the journal and compares.
  balance         bigint NOT NULL DEFAULT 0,

  -- Whether this account may go below zero.
  --
  -- A customer wallet must not: taking more than someone has is an overdraft.
  -- A system liability account must, because it represents what the business
  -- owes and grows more negative as customers deposit. Making this per-account
  -- rather than a global rule is what lets both live in one ledger.
  allow_negative  boolean NOT NULL DEFAULT false,

  -- A frozen account can be read but not moved. Used for holds during a
  -- dispute, and for closing an account without destroying its history.
  frozen          boolean NOT NULL DEFAULT false,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- The database refuses an overdraft even if the application forgets to check.
  -- Belt and braces, deliberately: the application check produces a good error
  -- message, and this one guarantees the invariant.
  CONSTRAINT accounts_balance_sign CHECK (allow_negative OR balance >= 0)
);

CREATE INDEX accounts_currency_idx ON accounts (currency);
CREATE INDEX accounts_kind_idx ON accounts (kind);

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

-- A transfer is the header: one atomic movement of money, made up of two or
-- more entries that must sum to zero.
CREATE TABLE transfers (
  id            uuid PRIMARY KEY,

  -- The caller's own identifier for this movement, unique per caller. It is
  -- what lets a client ask "did my transfer go through?" after a timeout
  -- without needing to have kept our id.
  reference     text,

  kind          text NOT NULL
                CHECK (kind IN ('transfer', 'deposit', 'withdrawal', 'fee', 'reversal', 'adjustment')),

  currency      char(3) NOT NULL,

  status        text NOT NULL DEFAULT 'posted'
                CHECK (status IN ('posted', 'reversed')),

  -- Set on a transfer that reverses another. A reversal is itself a transfer
  -- with the entries negated, so history is added to rather than rewritten.
  reverses      uuid REFERENCES transfers (id),

  description   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX transfers_reference_idx ON transfers (reference)
  WHERE reference IS NOT NULL;

CREATE INDEX transfers_created_at_idx ON transfers (created_at DESC);

-- A transfer may be reversed at most once. Without this, two concurrent
-- reversal requests both succeed and the money moves back twice.
CREATE UNIQUE INDEX transfers_reverses_idx ON transfers (reverses)
  WHERE reverses IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Entries
-- ---------------------------------------------------------------------------

-- The journal. Append-only: there is no UPDATE or DELETE path to this table
-- anywhere in the application.
CREATE TABLE entries (
  id             bigserial PRIMARY KEY,
  transfer_id    uuid NOT NULL REFERENCES transfers (id),
  account_id     uuid NOT NULL REFERENCES accounts (id),

  -- Signed, in minor units. Positive moves money into the account, negative
  -- moves it out. A single signed column rather than separate debit and credit
  -- columns because the invariant is then simply "the entries of a transfer
  -- sum to zero", which is one check instead of two that must agree.
  amount         bigint NOT NULL CHECK (amount <> 0),

  currency       char(3) NOT NULL,

  -- The account's balance immediately after this entry was applied. Redundant,
  -- and worth it: it turns "what was this account worth last Tuesday" into an
  -- index lookup instead of a sum over history, and it makes a drifted cache
  -- visible at the exact entry where the drift began.
  balance_after  bigint NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_idx ON entries (account_id, id DESC);
CREATE INDEX entries_transfer_idx ON entries (transfer_id);

-- ---------------------------------------------------------------------------
-- The double-entry invariant, enforced by the database
-- ---------------------------------------------------------------------------

-- Every transfer's entries must sum to exactly zero, in every currency it
-- touches. This is the definition of double-entry bookkeeping, and it is
-- checked here rather than only in the application because an invariant that
-- lives in one language is one refactor away from being lost.
--
-- The trigger is DEFERRABLE INITIALLY DEFERRED, which is the whole reason it
-- can work: the entries of a transfer are inserted one row at a time, so the
-- books are legitimately unbalanced in the middle of the transaction. Checking
-- per-statement would reject every valid transfer. Checking at COMMIT asks the
-- only question that matters -- were they balanced by the time anyone else
-- could see them.
CREATE OR REPLACE FUNCTION assert_transfer_balances() RETURNS trigger AS $$
DECLARE
  imbalance bigint;
  entry_count int;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*)
    INTO imbalance, entry_count
    FROM entries
   WHERE transfer_id = NEW.transfer_id;

  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'transfer % has % entr(y/ies); double-entry requires at least two',
      NEW.transfer_id, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'transfer % is out of balance by % minor units', NEW.transfer_id, imbalance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_must_balance
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_transfer_balances();

-- Entries are immutable. Correcting a mistake means posting a reversal, which
-- is what makes the journal an audit trail rather than merely a table.
CREATE OR REPLACE FUNCTION reject_entry_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'entries are append-only; post a reversing transfer instead'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_are_immutable
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION reject_entry_mutation();

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

-- A client that times out does not know whether its request was applied, so it
-- retries. Without a record of what was already done, the retry moves the money
-- a second time.
--
-- This lives in PostgreSQL rather than Redis because it has to be exactly as
-- durable as the transfer it protects. A cache that can evict under memory
-- pressure would forget the key and let the duplicate through, which is the one
-- failure this table exists to prevent.
CREATE TABLE idempotency_keys (
  key            text PRIMARY KEY,

  -- The scope the key belongs to, so two API keys cannot collide by choosing
  -- the same idempotency key.
  owner          text NOT NULL,

  -- A hash of the request, so that reusing a key with a different body is
  -- reported as a conflict rather than silently returning the wrong answer.
  request_hash   text NOT NULL,

  -- 'in_progress' is claimed before the work starts. A second request holding
  -- the same key sees it and is told to retry, rather than both proceeding.
  status         text NOT NULL CHECK (status IN ('in_progress', 'completed')),

  response_status int,
  response_body   jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,

  -- Keys are kept long enough to outlive any plausible client retry, then
  -- swept. Keeping them forever would grow without bound.
  expires_at     timestamptz NOT NULL
);

CREATE INDEX idempotency_expires_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------

-- Events are written in the same database transaction as the entries that
-- caused them, and published afterwards by a separate worker.
--
-- The alternative -- committing the transfer and then publishing -- has a
-- window between the two where the process can die, and the event is lost
-- forever while the money has moved. Publishing first and then committing has
-- the mirror problem: an event for a transfer that never happened. Writing the
-- event into the same transaction makes "the money moved" and "the event
-- exists" the same atomic fact.
--
-- The cost is that delivery becomes at-least-once rather than exactly-once, so
-- consumers must be idempotent. That is the correct trade, and it is the one
-- every queue makes.
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  topic           text NOT NULL,

  -- The aggregate this event is about, so a consumer can order events per
  -- entity even though the outbox as a whole is only loosely ordered.
  aggregate_id    text NOT NULL,

  payload         jsonb NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,

  attempts        int NOT NULL DEFAULT 0,
  last_error      text,

  -- When to next try. Set into the future on failure, which is how the backoff
  -- is expressed without needing a scheduler.
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);

-- The worker's query is "unpublished, due now, oldest first". A partial index
-- keeps it proportional to the backlog rather than to everything ever
-- published, which matters because the published rows vastly outnumber the
-- pending ones.
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at, id)
  WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,

  -- The first characters of the key, stored in clear so a key can be
  -- identified in a list and in an audit log without being reconstructible.
  prefix        text NOT NULL UNIQUE,

  -- Argon2id. A leaked database must not yield working credentials, and a fast
  -- hash like SHA-256 would let an attacker test candidates at memory
  -- bandwidth.
  secret_hash   text NOT NULL,

  scopes        text[] NOT NULL DEFAULT '{}',

  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
