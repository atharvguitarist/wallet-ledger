# Performance: query plans, indexes and the cost of the fraud rules

All numbers were measured on **1,000,002 ledger entries / 500,001 transfers** (PostgreSQL 16, a small cloud VM, warm cache), seeded with:

```bash
npm run seed -- --reset --users 2000 --wallets 4000 --transfers 380000
npm run perf:explain      # adds one "hot" wallet with 120,000 transfers, then runs EXPLAIN ANALYZE
npm run perf:rules        # 400 transfers with rules on vs off
```

Full plans: [performance-plans.md](performance-plans.md).

## Reconciliation checks (Milestone 4)

| Check | Time | Plan shape | Index needed? |
|---|---:|---|---|
| 1. ledger_totals (Σ debits = Σ credits) | 96 ms | Parallel Seq Scan + aggregate | **No.** It must read every row anyway; a full scan is the cheapest way. |
| 2. transfer_balance (GROUP BY transfer HAVING debits ≠ credits) | 733 ms | Merge join of `ledger_entries_transfer_idx` and `transfers_pkey`, GroupAggregate | **No new one.** It reads every entry; it happens to use the `transfer_id` index (already needed elsewhere) to get rows pre-sorted for the group-by. A hash aggregate over a seq scan would also be fine. |
| 3. stored_balance (stored = computed) | 184 ms | Parallel Seq Scan + HashAggregate by account | **No.** Every account must be summed. |
| 4. no_overdraft | 241 ms | Parallel Seq Scan + HashAggregate | **No.** |
| 5. orphans (transfers without entries, entries without transfers) | 567 ms | Parallel Hash Anti Joins (full scans of both tables) | **No for a nightly job.** The anti-join needs every row of both tables. `ledger_entries(transfer_id)` exists already and would let the planner use an index anti-join if it ever became cheaper. |

The whole run takes about 1.8 s on a million entries — fine for a job that runs at 02:30 once a night. **Every reconciliation check can afford a full table scan**: they all have to look at every row by definition, and adding indexes just for them would slow every transfer's `INSERT` all day to save a second or two at night. The one index that matters for correctness-at-scale is `ledger_entries(transfer_id)`, and it is already there for joins.

What would change at 100× the size: run checks 3 and 4 per day-partition or incrementally ("entries since the last run" + yesterday's verified totals), and partition `ledger_entries` by month so old, already-verified partitions are skipped.

## Statement pagination: OFFSET vs cursor

On a wallet with 120,001 entries, fetching 20 rows:

| Query | Time | What the plan does |
|---|---:|---|
| `ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 0` | **0.18 ms** | Index Scan on `ledger_entries_account_time_idx`, stops after 20 rows |
| same with `OFFSET 100000` | **273 ms** | Bitmap scan of all 120k entries for the wallet, hash-join to transfers, **external merge sort on disk**, then throws away 100,000 rows |
| cursor: `WHERE (created_at, id) < ($cursor) … LIMIT 20` | **0.27 ms** | Index Scan with `Index Cond: ROW(created_at, id) < ROW(…)`, reads exactly 20 rows |

**Why OFFSET gets slow:** the database cannot jump to row 100,001. It has to produce the first 100,020 rows in order — join, sort, count — and then discard 100,000 of them. Cost grows linearly with the page number. Here the planner even decided an index walk of 100k rows was so expensive that it switched to scanning and sorting everything.

**Why the cursor stays fast:** `(created_at, id) < (last_seen_created_at, last_seen_id)` is a range condition on the same composite index the query orders by, so Postgres seeks straight to the right spot and reads 20 entries. Page 5,000 costs the same as page 1. `id` is included so rows with the same timestamp (every entry in one transaction shares `now()`) still have a strict, stable order.

The API supports both: `GET /wallets/:id/statement?limit=20&offset=40` and `?limit=20&cursor=<next_cursor>`; every response includes `next_cursor`.

## Fraud rules: index per rule and added latency (Milestone 5)

| Rule | Query | Index that keeps it fast | Measured |
|---|---|---|---:|
| large_amount | none (compares amount to threshold) | — | ~0 |
| kyc_unverified_limit | none (KYC status is read with the locked account row) | `users_pkey` (join in the lock query) | ~0 |
| velocity | `count(*) … WHERE source_account_id = ? AND created_at > now() - 60s` | `transfers_source_time_idx (source_account_id, created_at)` → Index Only Scan | 0.08 ms |
| daily_limit | `SUM(amount) … WHERE source_account_id = ? AND created_at > now() - 24h` | same index, with `INCLUDE (amount, status)` so it never touches the table | 0.18 ms typical; 37 ms on the 120k-transfer hot wallet |
| new_payee_large | `EXISTS (… source = ? AND destination = ? AND status = 'completed')` | partial `transfers_payee_idx (source, destination) WHERE status = 'completed'` | 0.09 ms |

End to end, through the real money path, 400 transfers each way:

| Configuration | median | p95 |
|---|---:|---:|
| all rules enabled | 4.04 ms | 7.21 ms |
| all rules disabled | 3.34 ms | 6.07 ms |
| **added by the rules** | **0.70 ms** | 1.14 ms |

Honest gap: `daily_limit` sums every transfer in the last 24 h for the wallet. That is trivial for a person (a handful per day) but took 37 ms for the synthetic hot wallet with 86,000 transfers in 24 h, and it runs while the wallet row is locked. For merchant-style wallets I would keep a running daily total (a small `wallet_daily_totals` row updated in the same transaction) so the rule becomes a single-row read.

## The cost of indexes on writes

`ledger_entries` gets two inserts per transfer, so every index on it is paid twice per transfer, forever. That is why it has only two secondary indexes, and why none were added for the nightly checks above. `transfers` has four secondary indexes; two are partial (`WHERE status = 'completed'`, `WHERE status = 'held'`) so the held-queue index stays tiny. For reference, the seed script writes 100,000 transfers (200,000 entries, 100,000 audit rows, every constraint trigger firing, all indexes maintained) in about 9 seconds.
