-- 002_guards_and_audit.sql
-- Database-level guards: the application cannot break these even with a bug.

-- ---------------------------------------------------------------------------
-- 1. Ledger entries are append-only (requirement 6).
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed (post a reversal transfer instead)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();

CREATE TRIGGER ledger_entries_no_truncate
    BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_change();

-- ---------------------------------------------------------------------------
-- 2. Every transfer balances (requirement 5). A DEFERRED constraint trigger
--    runs at COMMIT, after all of the transfer's lines are inserted, and
--    rejects the whole transaction if debits <> credits or <> transfer.amount.
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_transfer_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_debits  BIGINT;
    v_credits BIGINT;
    v_amount  BIGINT;
BEGIN
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
           COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
      INTO v_debits, v_credits
      FROM ledger_entries
     WHERE transfer_id = NEW.transfer_id;

    SELECT amount INTO v_amount FROM transfers WHERE id = NEW.transfer_id;

    IF v_debits <> v_credits OR v_debits <> v_amount THEN
        RAISE EXCEPTION 'transfer % is unbalanced: debits=% credits=% amount=%',
            NEW.transfer_id, v_debits, v_credits, v_amount
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_transfer_balanced();

-- ---------------------------------------------------------------------------
-- 3. Transfers are immutable except for status (and only legal moves).
--    held -> completed | rejected ; completed -> reversed. Never deleted.
-- ---------------------------------------------------------------------------
CREATE FUNCTION guard_transfer_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'transfers cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('completed', 'held') THEN
            RAISE EXCEPTION 'a new transfer must start as completed or held, not %', NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE: only status (and the flagged marker) may change.
    IF (NEW.id, NEW.type, NEW.amount, NEW.source_account_id, NEW.destination_account_id,
        NEW.related_transfer_id, NEW.initiated_by_user_id, NEW.note, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.type, OLD.amount, OLD.source_account_id, OLD.destination_account_id,
        OLD.related_transfer_id, OLD.initiated_by_user_id, OLD.note, OLD.created_at) THEN
        RAISE EXCEPTION 'only the status of transfer % may change', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'held'      AND NEW.status IN ('completed', 'rejected')) OR
           (OLD.status = 'completed' AND NEW.status = 'reversed')
       ) THEN
        RAISE EXCEPTION 'illegal status change for transfer %: % -> %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transfers_guard
    BEFORE INSERT OR UPDATE OR DELETE ON transfers
    FOR EACH ROW EXECUTE FUNCTION guard_transfer_change();

-- ---------------------------------------------------------------------------
-- 4. Audit log (requirement 13). The app sets the actor once per transaction:
--      SELECT set_config('app.actor', 'admin:ops1', true);
-- ---------------------------------------------------------------------------
CREATE FUNCTION log_transfer_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO transfer_status_history (transfer_id, from_status, to_status, changed_by, reason)
        VALUES (
            NEW.id,
            CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
            NEW.status,
            COALESCE(NULLIF(current_setting('app.actor', true), ''), current_user),
            NULLIF(current_setting('app.reason', true), '')
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER transfers_status_audit
    AFTER INSERT OR UPDATE OF status ON transfers
    FOR EACH ROW EXECUTE FUNCTION log_transfer_status();

-- The audit log itself is append-only too.
CREATE TRIGGER transfer_status_history_append_only
    BEFORE UPDATE OR DELETE ON transfer_status_history
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();
