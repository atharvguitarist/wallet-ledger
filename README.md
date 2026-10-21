# Payments-Grade Wallet Ledger

The backend of a digital wallet — the kind behind a UPI app — built so that money never appears from nowhere, disappears, or moves twice.

**Node.js 22 · Express 5 · PostgreSQL 16 · plain SQL (`pg`), no ORM**

- Users open wallets, top up, send money to each other, and withdraw.
- Every rupee is recorded twice (debit + matching credit); the database refuses to commit an unbalanced transfer.
- 100 people spending from the same wallet at the same moment stays correct (row locks, tested 20× in a row).
- A retried payment is charged once (idempotency keys).
- A nightly job checks the books and reports every mismatch.
- Fraud rules hold or flag risky transfers; an LLM explains the flags and answers plain-English questions about your statement — but never decides anything and never writes SQL.

> 🎥 **Demo video:** _add your link here_

---

## Run it (one command)

Requirements: [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
docker compose up
```

That starts **Postgres** (host port 5433), the **API** on http://localhost:3000, and the **background worker** (nightly job at 02:30 IST; also runs once at start-up). Migrations run automatically.

In a second terminal, while it is running:

```bash
docker compose run --rm tests                       # the full test suite, inside Docker
docker compose exec api node scripts/demo.js --step # the 5-minute demo, scene by scene (press Enter between scenes)
```

Seed the large dataset (1,000 users, 2,000 wallets, 100,000 transfers):

```bash
docker compose exec api npm run seed
```

<details>
<summary>Running without Docker</summary>

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/wallet       # any PostgreSQL 15+
npm run migrate && npm start          # API
npm run worker                        # background worker (second terminal)
DATABASE_URL=postgres://user:pass@localhost:5432/wallet_test npm test  # DB name MUST end in _test; tests wipe it
```
</details>

CI (`.github/workflows/ci.yml`) runs the test suite against Postgres 16 **and** boots the stack with `docker compose up --wait`, runs the scripted demo against it, then runs the tests inside compose.

---

## Tests

`npm test` — 44 tests, all passing. The four required groups:

| Test file | What it proves |
|---|---|
| `tests/stampede.test.js` | ₹500 wallet, 100 concurrent ₹10 transfers, **20 runs in a row**: exactly 50 succeed, the wallet ends at ₹0, its running balance never dips below 0, total debits = total credits. |
| `tests/idempotency.test.js` | 5 sequential retries → 1 transfer, 5 byte-identical responses · 10 parallel requests with one key → 1 transfer · same key, different amount → 422, no money moves · failed payments replay as the same failure · keys are per user. |
| `tests/reconciliation.test.js` | Seed 10,000 transfers, then corrupt the DB directly (change an entry's amount, delete a credit, change a stored balance) → the job reports **exactly those three problems and nothing else**. Also: only one run at a time. |
| `tests/statement-qa.test.js` | 10 sample questions with expected answers, plus prompt injection via the question, via a transfer note, and via a "hijacked" LLM reply — the answer always covers only the caller's own rows. |
| `tests/fraud-and-audit.test.js` | Held transfers move no money until released; reject; thresholds change via SQL; reversal; LLM explanations validated; audit log append-only. |
| `tests/schema-guards.test.js` | The database itself rejects: updating/deleting ledger lines, unbalanced transfers, negative wallet balances, negative amounts, editing a transfer, duplicate idempotency keys. |
| `tests/api.test.js` | One error shape everywhere, ownership checks, withdrawals + fee, multiple wallets, offset vs cursor pagination. |

Tests use a **mock LLM**, so they need no network or API key.

---

## Project layout

```
migrations/            001 tables · 002 triggers (append-only, balanced, audit) · 003 indexes · 004 system accounts + rules
src/
  services/transfers.js     ← THE MONEY PATH: locks, balance check, ledger writes (read this first)
  idempotency.js            ← Milestone 3: claim key → run → save response → commit
  services/risk.js          ← fraud rules, thresholds from the risk_rules table
  services/reconciliation.js← nightly checks (REPEATABLE READ, job lock, root-cause attribution)
  services/flagExplainer.js ← LLM explains flags (nightly)
  services/statementQa.js   ← LLM → JSON → validate → our own SQL
  services/statement.js     ← statements, offset + cursor pagination
  llm/                      ← one interface: mock | anthropic | openai-compatible
  routes/                   ← HTTP endpoints
  worker.js                 ← cron: reconciliation → flag explanations → idempotency-key cleanup
scripts/
  seed.js · migrate.js · demo.js
  isolation-lab.js (→ docs/isolation.md) · break-it.js (→ docs/race-demo.md)
  explain-analyze.js · bench-rules.js (→ docs/performance.md)
docs/  schema.md · isolation.md · race-demo.md · performance.md · statement-qa.md
```

---

## API

Authentication is simulated (real login was out of scope): send **`X-User-Id: <id>`** to act as a user, or **`X-Admin-Token: <ADMIN_TOKEN>`** (default `dev-admin-token`) plus optional `X-Admin-Id: <name>` for admin routes. Every **POST** needs an **`Idempotency-Key: <uuid>`** header. All amounts are **integers in paise** (`50000` = ₹500).

| Method & path | Who | What |
|---|---|---|
| `POST /users` | anyone | create user `{name, email, phone}` (gets a `main` wallet) |
| `GET /users/:id` · `GET /users/:id/wallets` | that user | profile, wallets |
| `POST /users/:id/wallets` | that user | open another wallet `{name}` |
| `GET /wallets/:id/balance` | owner | balance |
| `GET /wallets/:id/statement?limit=&offset=` or `?cursor=` | owner | entries, newest first |
| `POST /wallets/:id/topup` | owner | `{amount, note?}` cash-in → wallet |
| `POST /wallets/:id/withdraw` | owner | `{amount, note?}` wallet → cash-out, plus a ₹2 fee transfer |
| `POST /transfers` | owner of source | `{from_wallet_id, to_wallet_id, amount, note?}` → **201** completed or **202** held |
| `GET /transfers/:id` | parties / admin | transfer + ledger lines + status history + flags |
| `POST /users/:id/statement/ask` | that user | `{question}` → answer + transfer ids |
| `GET /admin/transfers?status=held` | admin | review queue |
| `POST /admin/transfers/:id/release` · `/reject` · `/reverse` | admin | `{reason?}` |
| `POST /admin/users/:id/kyc` | admin | `{kyc_status}` |
| `POST /admin/reconciliation/run` · `GET /admin/reconciliation/runs[/:id]` | admin | manual run, reports |
| `POST /admin/risk/explain` · `GET /admin/risk-flags` · `GET /admin/risk-rules` | admin | LLM explanations, flags, rules |

Every error: `{"code": "INSUFFICIENT_FUNDS", "message": "…", "request_id": "…"}`.

```bash
curl -X POST localhost:3000/transfers \
  -H 'content-type: application/json' -H 'X-User-Id: 1' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"from_wallet_id": 4, "to_wallet_id": 5, "amount": 25000, "note": "dinner"}'
```

---

## Design questions answered

### Milestone 1 — schema ([full write-up: docs/schema.md](docs/schema.md))

**Do you store each account's balance, compute it from ledger entries, or both? What does each cost?**
**Both.** The ledger is the source of truth; `accounts.balance` is a cached copy updated in the same transaction as the entries.

| Option | Gains | Costs |
|---|---|---|
| Compute only | One source of truth, nothing can drift | Every balance read and every transfer's funds check is a `SUM` over all of the wallet's history — slower as history grows. And there is no single row to lock, so you need Serializable or advisory locks to stop two spends racing. |
| Store only | Fast reads; one row to `SELECT … FOR UPDATE` | A bug or a manual edit silently corrupts money with no way to prove it. |
| **Both (chosen)** | Fast reads, a natural lock target, a `CHECK (balance >= 0)` the DB enforces, and the ledger to prove it | Two writes per side per transfer, and the two can drift — which is exactly why the nightly job compares them. |

**Why store user wallets and system accounts in the same table?**
Because to the ledger they are the same thing: something money moves into and out of. One `accounts` table means `ledger_entries.account_id` is a single plain foreign key, a transfer is always "account → account" whatever its type, and the reconciliation checks are one query over every account (including proving that all balances sum to zero). The differences are captured with a `kind` column and CHECK constraints: a wallet must have a `user_id` and can't go negative; a system account has a `system_code`, no user, and may go negative (cash-in is negative by exactly the money ever topped up). Two tables would need either a polymorphic `account_type + account_id` pair that no foreign key can check, or two nullable FK columns on every ledger line.

**Which columns hold data you don't control (phone, email)? Why is none of them a primary key?**
`users.email`, `users.phone`, `users.name` — and the user-chosen `transfers.note` and wallet `name`. Email and phone belong to the outside world: people change them, telecoms recycle numbers, formats vary (+91 or not, letter case). A primary key must never change and is copied into every foreign key, so using one of these would mean rewriting every wallet, transfer and key row when a user changes their number — or, worse, a recycled number attaching to someone else's history. So every table uses a system-generated `BIGINT` identity, and email/phone are just `UNIQUE` (email case-insensitively via `lower(email)`). They are also personal data you'd rather not spread through every table and log line.

### Milestone 2 — concurrency ([docs/isolation.md](docs/isolation.md), [docs/race-demo.md](docs/race-demo.md))

**Which isolation level does the transfer run at, and why?** **Read Committed + `SELECT … FOR UPDATE`**, rows locked one by one in ascending `account_id` order. The decision a transfer makes depends only on the balance of the row it locks, so once that row is locked nobody else can change it, and a waiting transfer re-reads the new value after the first commits. Ascending order means A→B and B→A both lock `min(A,B)` first, so they queue instead of deadlocking.

**Is Read Committed with row locks enough, or would you use Serializable?** Enough here. Serializable would also be correct, but it costs: every conflicting transaction is *aborted* (SQLSTATE 40001) and must be retried from the start, so on a hot wallet you'd do much of the work twice or more; SSI also tracks every transaction's reads, adding CPU/memory and some false-positive aborts. Its unique benefit is preventing write skew — decisions based on rows you don't write (shown in case 3b of the lab). Our invariant lives on the row we lock *and* is a CHECK constraint, and the fraud rules (which read other rows) run after the wallet is locked, so they are serialized too. I'd switch to Serializable if a rule ever had to hold across rows we don't lock, e.g. "a user's wallets *together* may not send more than X today" — or, better, lock the user row.

**Break it first:** with no locks, all 100 requests passed the app's balance check; one variant was saved only by the `CHECK (balance >= 0)` constraint, the other **created ₹990 from nothing** with a lost update. Details and output: [docs/race-demo.md](docs/race-demo.md).

### Milestone 3 — idempotency (`src/idempotency.js`)

In one transaction: insert `(user_id, key, sha256(method+path+body))` **first**, then run the transfer inside a savepoint, save the status code and exact body text on the key row, commit. If the insert hits the unique constraint, the key was seen before: same hash → return the saved response byte-for-byte (`Idempotent-Replayed: true`); different hash → `422 IDEMPOTENCY_KEY_MISMATCH`. When two identical requests arrive at once, the second insert *waits* on the first's uncommitted row and then sees it as a duplicate — the unique constraint does the hard part. I use `INSERT … ON CONFLICT DO NOTHING` (no row returned = duplicate), which has the same waiting behaviour as catching the unique-violation error but doesn't abort the transaction.

Choices: business errors (insufficient funds, forbidden…) are saved and replayed too, so a retry gets the same answer rather than a second attempt hours later; unexpected 500s roll the key back so the client can safely retry; `response_body` is `TEXT`, not `JSONB`, because JSONB reorders keys and replays must be identical. Keys older than 24 h are deleted by the nightly worker.

### Milestone 4 — reconciliation (`src/services/reconciliation.js`, [docs/performance.md](docs/performance.md))

Five SQL checks in one `REPEATABLE READ` transaction, started by `SELECT … FROM job_locks … FOR UPDATE NOWAIT` (a second run exits immediately). It writes one `reconciliation_runs` row and one `reconciliation_issues` row per problem, and never fixes anything.

**Root-cause attribution.** One corrupted ledger line trips several checks at once: its transfer no longer balances, its account's stored balance no longer matches, the global totals are off. Reporting all of them would make the acceptance test show 5+ problems for 3 corruptions and would send an on-call engineer chasing symptoms. So the unbalanced *transfer* is reported as the root cause, and an account mismatch is suppressed only when it equals exactly the imbalance of the broken transfers that account takes part in (so an independent corruption on the same account is still reported). Suppressed findings are kept in the run's `summary.explained`, so nothing is hidden.

**Full scans vs indexes on 1M entries:** all five checks can afford a full table scan — they have to read every row by definition, and the whole run takes ~1.8 s. Adding indexes just for a nightly job would slow every transfer all day. The only index involved, `ledger_entries(transfer_id)`, already exists for joins. **The statement endpoint is the opposite**: `OFFSET 100000` took 273 ms (it builds, sorts and throws away 100,000 rows) while the cursor version took 0.27 ms on the same index. Numbers and plans: [docs/performance.md](docs/performance.md).

### Milestone 5 — fraud rules and the LLM

Rules (`risk_rules` table; change with SQL, no deploy):

| Rule | Action | Default | Index |
|---|---|---|---|
| `large_amount` | hold | ≥ ₹50,000 | — |
| `daily_limit` | hold | > ₹1,00,000 sent in 24 h | `transfers_source_time_idx … INCLUDE (amount, status)` |
| `kyc_unverified_limit` | hold | KYC not verified and > ₹5,000 | — (read with the locked row) |
| `velocity` | flag | > 10 outgoing in 60 s | `transfers_source_time_idx` |
| `new_payee_large` | flag | first payment to this wallet and ≥ ₹10,000 | partial `transfers_payee_idx` |

They run inside the transfer transaction after the wallet row is locked and the balance checked. **Measured cost: +0.70 ms median per transfer** (4.04 ms vs 3.34 ms). A held transfer has no ledger lines and changes no balance until an admin releases it (funds are re-checked at release); rejecting it moves nothing.

The LLM sits behind one tiny interface (`complete()` returning a string) with three providers: `mock` (default; deterministic, used in all tests), `anthropic`, and `openai` (any OpenAI-compatible endpoint). It never sees credentials or the database, never writes SQL, and its output is always validated: explanation labels outside `likely_ok | review | likely_fraud` become `review`; statement intents must be exactly `{type, counterparty, from, to}` with type 1–4, real dates and a plain name, otherwise the user gets "I can only answer these four kinds of question". The user id in the query always comes from the request. Transfer notes reach the LLM only inside a JSON data block with an instruction to treat them as data. To use a real model: `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=… docker compose up`.

---

## Assumptions

- **Auth is simulated** with `X-User-Id` / `X-Admin-Token` headers; the brief has no login requirement. Ownership is still enforced on every wallet route.
- Withdrawals charge a flat **₹2 fee** (`WITHDRAWAL_FEE_PAISE`) as a *separate* `fee` transfer pointing at the withdrawal. A held withdrawal is charged its fee when released. Reversing a withdrawal does not refund the fee automatically; an admin reverses the fee transfer separately.
- Funds are checked when a transfer is held *and again* at release (the money may have been spent meanwhile).
- A user can send to any user wallet but never directly to a system account; moving between your own wallets is a normal P2P transfer.
- "Received" in Q&A means P2P money from other users (not your own top-ups). Dates are IST days, inclusive.
- Idempotency keys are scoped per user; `POST /users` and admin calls share a "no user" scope (`NULLS NOT DISTINCT`).
- Amounts above ₹1,000 crore per request are rejected; BIGINTs are converted to JS numbers only when they fit exactly (2^53 paise ≈ ₹90 lakh crore).

## Trade-offs I made

- **Stored + computed balances**: faster and lockable, at the cost of a nightly proof that they agree.
- **System accounts are locked rows too.** Every top-up locks `cash_in`, so all top-ups in the system are serialized behind one row. Fine at this scale; it's the first thing that would hurt at UPI scale (see next steps).
- **Read Committed + locks over Serializable**: no retry storms on hot wallets, at the cost of having to reason carefully about which rows each decision depends on.
- **Positive amount + direction** over signed amounts: a stricter CHECK and clearer reports, at the cost of a `CASE` when summing.
- **Plain SQL, no ORM**: the money path is longer to write but every query, lock and transaction boundary is visible, as the brief asks.
- The LLM call for statement Q&A happens inside the idempotency transaction, holding a connection for ~1 s with a real provider. Simple and correct; at scale I'd parse the question first and only open the transaction for the query.

## What I'd do next

1. **Remove the system-account hotspot:** don't store a balance for system accounts (compute nightly), or split `cash_in` into N sub-accounts and pick one by hash, so top-ups stop contending on one row.
2. **Real authentication** (JWT/OAuth) and per-route rate limiting; a separate DB role for the app that has only `INSERT, SELECT` on `ledger_entries`.
3. **Partition `ledger_entries` by month** and make reconciliation incremental (only new partitions + carried-forward totals).
4. Keep a running **daily-total row per wallet** so `daily_limit` is one row read even for merchant wallets (it took 37 ms on a synthetic 86k-transfers-a-day wallet).
5. **Sharding** (stretch milestone): shard by `user_id` with consistent hashing so a user's wallets live together; a cross-shard P2P transfer becomes a saga (debit on shard A with an outbox event → credit on shard B, idempotent on the transfer id) instead of one ACID transaction.
6. Outbox/webhooks for transfer events; Prometheus metrics for lock wait time, rule latency and reconciliation duration.
