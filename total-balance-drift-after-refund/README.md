# totalBalance drifts after refund or authorization adjustment

Saleor derives an order's `totalBalance` at read time from `total.gross.amount`, `totalCaptured.amount`, and `totalRefunded.amount`, which are themselves rolled up from every `TransactionItem` on the order. A partial refund that reports a `REFUND_SUCCESS` event without a matching correction to that transaction's own `chargedAmount`, or an authorization adjustment that changes `authorizedAmount` without a follow-up capture or void event, leaves those fields disagreeing with each other, so the reported `totalBalance` drifts from what the numbers would suggest on their own.

This job pages through orders, classifies each one with a pure decision function, and always reports every drifted order for finance review, `{orderId, orderNumber, expectedBalance, reportedBalance, driftedBy}`. It never writes a correction automatically. A correcting transaction event is only ever recorded when `DRY_RUN=false` and a human has signed off on the specific transaction, event type, and amount, since the right fix depends on reading the actual raw events.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/total-balance-drift-after-refund/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python total-balance-drift-after-refund/python/flag_balance_drift.py
node   total-balance-drift-after-refund/node/flag-balance-drift.js
```

`classify_balance_drift` is a pure function: it recomputes the expected balance as `total - totalCaptured + totalRefunded`, returns `OK` when that matches the reported `totalBalance` (within a small epsilon for floating point rounding), and `BALANCE_DRIFTED` with the signed `driftedBy` amount otherwise. Only the report is ever automatic. A corrective event is only recorded when `DRY_RUN=false`, and only for an order a human has explicitly signed off on with the transaction id, event type, and amount to record. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest total-balance-drift-after-refund/python
node --test total-balance-drift-after-refund/node
```
