# Captured amount doubles the order total

Saleor computes an order's `totalCaptured` by summing `chargedAmount` across every `TransactionItem` linked to the order, and it deduplicates `CHARGE_SUCCESS` events only within a single `TransactionItem`, keyed by `(type, pspReference)`. There is no order-level guard that caps the aggregate at `order.total`. A checkout retry, a webhook redelivery with a new `pspReference`, or a second manual `transactionCreate` or legacy `orderCapture` call can each produce a second `TransactionItem`, or a second event with a different `pspReference`, reporting a full `CHARGE_SUCCESS`, and Saleor sums both, so `totalCaptured` becomes double the order total.

This job pages through orders, classifies each one with a pure decision function, and always reports every over-captured order for finance review, `{orderId, orderNumber, total, totalCaptured, overBy, transactionIds}`. It never refunds automatically. A corrective refund of the exact `overBy` amount is only ever issued when `DRY_RUN=false` and a human has signed off on that specific order, since the extra capture may reflect a real second charge the customer actually paid.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/captured-amount-doubles-order-total/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python captured-amount-doubles-order-total/python/flag_over_captured.py
node   captured-amount-doubles-order-total/node/flag-over-captured.js
```

`classify_order_capture` is a pure function: it sums `chargedAmount` across the order's transactions, returns `OK` when that sum is at or below `order.total` (within a small epsilon for floating point rounding), and `OVER_CAPTURED` with the overage and the culprit transaction ids otherwise. Culprits are the transactions whose own `chargedAmount` already reaches the full order total on its own, the signature of a duplicate full-amount capture rather than a same-reference duplicate Saleor already dedupes. Only the report is ever automatic. A refund is only issued when `DRY_RUN=false`, and only for an order a human has explicitly signed off on. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest captured-amount-doubles-order-total/python
node --test captured-amount-doubles-order-total/node
```
