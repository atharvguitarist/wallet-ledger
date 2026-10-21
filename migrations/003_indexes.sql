-- 003_indexes.sql
-- One index per real query. Every index here costs something on every INSERT
-- into its table, so each one names the query that pays for it.

-- GET /wallets/:id/statement  ->  WHERE account_id = ? ORDER BY created_at DESC, id DESC
-- Also serves the cursor version: WHERE account_id = ? AND (created_at, id) < (?, ?)
CREATE INDEX ledger_entries_account_time_idx ON ledger_entries (account_id, created_at DESC, id DESC);

-- Reconciliation orphan check, GET /transfers/:id, the balance trigger.
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- Fraud rules "velocity" and "daily_limit": WHERE source_account_id = ? AND created_at > ?
-- INCLUDE lets daily_limit SUM(amount) without visiting the table (index-only scan).
CREATE INDEX transfers_source_time_idx ON transfers (source_account_id, created_at) INCLUDE (amount, status);

-- Statement Q&A "received", and the wallet's last-10-transfers query for the LLM explainer.
CREATE INDEX transfers_destination_time_idx ON transfers (destination_account_id, created_at);

-- Fraud rule "new_payee_large": has this wallet ever paid this destination?
CREATE INDEX transfers_payee_idx ON transfers (source_account_id, destination_account_id) WHERE status = 'completed';

-- Admin review queue: GET /admin/transfers?status=held  (partial = tiny)
CREATE INDEX transfers_held_idx ON transfers (created_at) WHERE status = 'held';

-- A transfer can be reversed at most once.
CREATE UNIQUE INDEX transfers_one_reversal_idx ON transfers (related_transfer_id) WHERE type = 'reversal';
-- Find the fee that belongs to a withdrawal.
CREATE INDEX transfers_related_idx ON transfers (related_transfer_id) WHERE related_transfer_id IS NOT NULL;

CREATE INDEX transfer_status_history_transfer_idx ON transfer_status_history (transfer_id, changed_at);

-- Nightly cleanup of keys older than 24h.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Nightly LLM explainer: flags not yet explained.
CREATE INDEX risk_flags_unexplained_idx ON risk_flags (created_at) WHERE explained_at IS NULL;

CREATE INDEX reconciliation_issues_run_idx ON reconciliation_issues (run_id);
