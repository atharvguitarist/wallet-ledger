-- 001_schema.sql
-- Core tables for the wallet ledger. Money is always whole paise in BIGINT.
-- Every table has a system-generated BIGINT primary key.

-- ---------------------------------------------------------------------------
-- users: people on the platform. email/phone are data we don't control, so
-- they are UNIQUE attributes, never primary keys.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    email       TEXT        NOT NULL CHECK (position('@' IN email) > 1),
    phone       TEXT        NOT NULL CHECK (phone ~ '^\+?[0-9]{10,15}$'),
    kyc_status  TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));
CREATE UNIQUE INDEX users_phone_uniq ON users (phone);

-- ---------------------------------------------------------------------------
-- accounts: BOTH user wallets and system accounts (cash-in, cash-out, fees).
-- One table means a ledger entry always points at exactly one account with a
-- plain foreign key, and every check (balances, reconciliation) is one query.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         TEXT        NOT NULL CHECK (kind IN ('user_wallet', 'system')),
    user_id      BIGINT      REFERENCES users (id),
    system_code  TEXT        CHECK (system_code IN ('cash_in', 'cash_out', 'fee_revenue')),
    name         TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
    currency     CHAR(3)     NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    -- Stored (cached) balance in paise = SUM(credits) - SUM(debits) of its entries.
    balance      BIGINT      NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A user wallet has an owner and no system code; a system account the reverse.
    CONSTRAINT accounts_owner_matches_kind CHECK (
        (kind = 'user_wallet' AND user_id IS NOT NULL AND system_code IS NULL) OR
        (kind = 'system'      AND user_id IS NULL     AND system_code IS NOT NULL)
    ),
    -- Requirement 7: a user wallet can never go below zero. System accounts may.
    CONSTRAINT accounts_wallet_non_negative CHECK (kind = 'system' OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_user_name_uniq   ON accounts (user_id, name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_code_uniq ON accounts (system_code)   WHERE system_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- transfers: the business event. Money only moves through a transfer.
-- source/destination are kept on the transfer so a HELD transfer (which has
-- no ledger entries yet) still knows where money will go when released.
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type                    TEXT        NOT NULL
                                        CHECK (type IN ('topup', 'p2p', 'withdrawal', 'fee', 'reversal')),
    status                  TEXT        NOT NULL
                                        CHECK (status IN ('completed', 'held', 'rejected', 'reversed')),
    amount                  BIGINT      NOT NULL CHECK (amount > 0),
    source_account_id       BIGINT      NOT NULL REFERENCES accounts (id),
    destination_account_id  BIGINT      NOT NULL REFERENCES accounts (id),
    -- reversal -> the transfer it undoes; fee -> the withdrawal it belongs to
    related_transfer_id     BIGINT      REFERENCES transfers (id),
    initiated_by_user_id    BIGINT      REFERENCES users (id),
    note                    TEXT        CHECK (length(note) <= 280),
    flagged                 BOOLEAN     NOT NULL DEFAULT false,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT transfers_distinct_accounts CHECK (source_account_id <> destination_account_id),
    CONSTRAINT transfers_related_required  CHECK ((type IN ('reversal', 'fee')) = (related_transfer_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- ledger_entries: append-only debit/credit lines. Amount is always positive;
-- the direction column carries the sign. Triggers (002) forbid UPDATE/DELETE
-- and force each transfer's debits to equal its credits at COMMIT.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id  BIGINT      NOT NULL REFERENCES transfers (id),
    account_id   BIGINT      NOT NULL REFERENCES accounts (id),
    direction    TEXT        NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount       BIGINT      NOT NULL CHECK (amount > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- transfer_status_history: audit log of every status change (requirement 13).
-- Written by a trigger, so no code path can change a status without a row here.
-- ---------------------------------------------------------------------------
CREATE TABLE transfer_status_history (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id  BIGINT      NOT NULL REFERENCES transfers (id),
    from_status  TEXT,
    to_status    TEXT        NOT NULL,
    changed_by   TEXT        NOT NULL,
    reason       TEXT,
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- idempotency_keys: one row per (user, client key). NULLS NOT DISTINCT (PG15+)
-- makes anonymous/admin requests (user_id NULL) unique per key as well.
-- response_body is TEXT, not JSONB, so a replay returns the exact same bytes.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      REFERENCES users (id),
    idempotency_key  UUID        NOT NULL,
    request_method   TEXT        NOT NULL,
    request_path     TEXT        NOT NULL,
    request_hash     CHAR(64)    NOT NULL,           -- SHA-256 of method + path + body
    status           TEXT        NOT NULL DEFAULT 'in_progress'
                                 CHECK (status IN ('in_progress', 'completed')),
    response_code    INT,
    response_body    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,

    CONSTRAINT idempotency_keys_user_key_uniq UNIQUE NULLS NOT DISTINCT (user_id, idempotency_key),
    CONSTRAINT idempotency_keys_response_when_done CHECK ((status = 'completed') = (response_code IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Fraud rules: thresholds live in data, not code.
-- ---------------------------------------------------------------------------
CREATE TABLE risk_rules (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code              TEXT        NOT NULL UNIQUE,
    description       TEXT        NOT NULL,
    action            TEXT        NOT NULL CHECK (action IN ('hold', 'flag')),
    applies_to        TEXT[]      NOT NULL,           -- transfer types this rule checks
    amount_threshold  BIGINT      CHECK (amount_threshold > 0),
    count_threshold   INT         CHECK (count_threshold > 0),
    window_seconds    INT         CHECK (window_seconds > 0),
    enabled           BOOLEAN     NOT NULL DEFAULT true,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE risk_flags (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id      BIGINT      NOT NULL REFERENCES transfers (id),
    rule_id          BIGINT      NOT NULL REFERENCES risk_rules (id),
    action           TEXT        NOT NULL CHECK (action IN ('hold', 'flag')),
    details          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    llm_label        TEXT        CHECK (llm_label IN ('likely_ok', 'review', 'likely_fraud')),
    llm_explanation  TEXT,
    llm_provider     TEXT,
    explained_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT risk_flags_one_per_rule UNIQUE (transfer_id, rule_id)
);

-- ---------------------------------------------------------------------------
-- Background jobs: a lock row per job, one row per run, one row per problem.
-- ---------------------------------------------------------------------------
CREATE TABLE job_locks (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_name   TEXT        NOT NULL UNIQUE,
    locked_by  TEXT,
    locked_at  TIMESTAMPTZ
);

CREATE TABLE reconciliation_runs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    triggered_by   TEXT        NOT NULL,
    status         TEXT        NOT NULL CHECK (status IN ('ok', 'problems_found', 'failed')),
    started_at     TIMESTAMPTZ NOT NULL,
    finished_at    TIMESTAMPTZ NOT NULL,
    checks_run     INT         NOT NULL DEFAULT 0,
    problem_count  INT         NOT NULL DEFAULT 0,
    total_debits   BIGINT,
    total_credits  BIGINT,
    summary        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    error          TEXT
);

CREATE TABLE reconciliation_issues (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id       BIGINT      NOT NULL REFERENCES reconciliation_runs (id),
    check_name   TEXT        NOT NULL,
    entity_type  TEXT        NOT NULL CHECK (entity_type IN ('ledger', 'transfer', 'account', 'ledger_entry')),
    entity_id    BIGINT,
    expected     BIGINT,
    actual       BIGINT,
    details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
