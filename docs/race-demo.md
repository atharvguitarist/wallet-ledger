# Break it first (Milestone 2, Step 2)

[`scripts/break-it.js`](../scripts/break-it.js) (`npm run lab:break-it`) fires **100 parallel ₹10 transfers out of a ₹500 wallet** three ways. The naive version reads the balance, checks it in JavaScript, then writes, with no transaction and no lock — exactly the bug in the brief. Output, unedited (identical on repeated runs):

```
Variant A — no lock, relative UPDATE (balance = balance - amount)
  succeeded: 50   rejected by app: 0   blocked by DB CHECK: 50
  sender balance: 0 paise   receiver balance: 50000 paise
  money created out of thin air: 0 paise (₹0)

Variant B — no lock, absolute UPDATE (balance = value computed in app)
  succeeded: 100   rejected by app: 0   blocked by DB CHECK: 0
  sender balance: 49000 paise   receiver balance: 100000 paise
  money created out of thin air: 99000 paise (₹990)

Fixed — one transaction, SELECT ... FOR UPDATE in id order (src/services/transfers.js)
  succeeded: 50   rejected by app: 50   blocked by DB CHECK: 0
  sender balance: 0 paise   receiver balance: 50000 paise
  money created out of thin air: 0 paise (₹0)
```

What it shows:

- **The application's balance check is useless without a lock.** In both broken variants, *all 100* requests read ₹500 and passed the "enough money?" check (`rejected by app: 0`).
- **Variant A (would-be overdraft):** the only thing that stopped the wallet going to −₹500 was the database's `CHECK (balance >= 0)`. That is why the brief says to enforce rules as constraints: the constraint caught what the code missed. But the app still showed 50 users an ugly database error instead of a clean "insufficient funds".
- **Variant B (lost update):** each request writes `balance = 50000 − 1000` that it computed from a stale read, overwriting the others. All 100 "succeed", the receiver gets ₹1,000, the sender still shows ₹490: **₹990 created from nothing**. No constraint can catch this, because every individual value written is valid.
- **Fixed:** `SELECT … FOR UPDATE` makes the 100 transfers queue on the wallet row. Each re-reads the real balance under the lock: exactly 50 succeed, 50 get `INSUFFICIENT_FUNDS`, the books balance.

The broken variants write balances directly and skip the ledger on purpose; running the reconciliation job afterwards on that database reports exactly 4 `stored_balance` problems: the sender and receiver wallets of both broken variants, and nothing for the fixed one. That is exactly what that job is for.
