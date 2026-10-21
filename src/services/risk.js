'use strict';

// Fraud rules (Milestone 5, Part A).
// Each rule is one query that runs INSIDE the transfer transaction, after the
// source wallet row is locked and before anything is written. Thresholds come
// from the risk_rules table on every call, so ops can change them with SQL.
// The rules make every decision. The LLM only explains afterwards.

const RULES = {
  // No query needed: compares the amount with the threshold.
  async large_amount(client, rule, { amount }) {
    if (amount < rule.amount_threshold) return null;
    return { amount, threshold: rule.amount_threshold };
  },

  // Index: transfers_source_time_idx (source_account_id, created_at)
  async velocity(client, rule, { source }) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS recent
         FROM transfers
        WHERE source_account_id = $1
          AND created_at > now() - make_interval(secs => $2)`,
      [source.id, rule.window_seconds]
    );
    const countWithThisOne = rows[0].recent + 1;
    if (countWithThisOne <= rule.count_threshold) return null;
    return { count: countWithThisOne, threshold: rule.count_threshold, window_seconds: rule.window_seconds };
  },

  // Index: transfers_source_time_idx ... INCLUDE (amount, status) -> index-only scan
  async daily_limit(client, rule, { source, amount }) {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS sent
         FROM transfers
        WHERE source_account_id = $1
          AND status IN ('completed', 'held')
          AND created_at > now() - make_interval(secs => $2)`,
      [source.id, rule.window_seconds]
    );
    const total = rows[0].sent + amount;
    if (total <= rule.amount_threshold) return null;
    return { total_with_this_transfer: total, threshold: rule.amount_threshold, window_seconds: rule.window_seconds };
  },

  // Index: transfers_payee_idx (source_account_id, destination_account_id) WHERE status = 'completed'
  async new_payee_large(client, rule, { source, destination, amount }) {
    if (amount < rule.amount_threshold) return null;
    const { rows } = await client.query(
      `SELECT EXISTS (
          SELECT 1 FROM transfers
           WHERE source_account_id = $1 AND destination_account_id = $2 AND status = 'completed'
       ) AS paid_before`,
      [source.id, destination.id]
    );
    if (rows[0].paid_before) return null;
    return { amount, threshold: rule.amount_threshold, first_payment_to_account: destination.id };
  },

  // Uses kyc_status already read (and locked) with the source account row.
  async kyc_unverified_limit(client, rule, { source, amount }) {
    if (source.kyc_status === 'verified' || amount <= rule.amount_threshold) return null;
    return { kyc_status: source.kyc_status, amount, threshold: rule.amount_threshold };
  },
};

/**
 * Returns { action: 'allow' | 'flag' | 'hold', hits: [...] }.
 * Any 'hold' rule that fires wins; otherwise any fired rule just flags.
 */
async function evaluateRisk(client, { type, source, destination, amount }) {
  const { rows: rules } = await client.query(
    `SELECT id, code, action, amount_threshold, count_threshold, window_seconds
       FROM risk_rules
      WHERE enabled AND $1 = ANY (applies_to)
      ORDER BY id`,
    [type]
  );
  const hits = [];
  for (const rule of rules) {
    const check = RULES[rule.code];
    if (!check) continue; // a rule row with no implementation is ignored, not fatal
    const details = await check(client, rule, { source, destination, amount });
    if (details) hits.push({ rule_id: rule.id, code: rule.code, action: rule.action, details });
  }
  const action = hits.some((h) => h.action === 'hold') ? 'hold' : hits.length > 0 ? 'flag' : 'allow';
  return { action, hits };
}

async function recordFlags(client, transferId, hits) {
  for (const hit of hits) {
    await client.query(
      `INSERT INTO risk_flags (transfer_id, rule_id, action, details) VALUES ($1, $2, $3, $4)`,
      [transferId, hit.rule_id, hit.action, JSON.stringify(hit.details)]
    );
  }
}

module.exports = { evaluateRisk, recordFlags, RULE_CODES: Object.keys(RULES) };
