# Charged amount stays stale after manual capture

Saleor's `Order.totalCharged` and `TransactionItem.chargedAmount` only recalculate from the ledger of `TransactionEvent` records attached to a transaction, never live from the gateway. When a manual capture happens directly at the gateway, or through `transactionRequestAction`, but the confirmation only arrives asynchronously, Saleor has nothing to recalculate from until an app explicitly reports it back with `transactionEventReport`. This job cross-checks stalled transactions against the gateway by `pspReference`, reports confirmed successes and failures back to Saleor, and flags anything ambiguous for finance review instead of guessing.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/charged-amount-stale-after-manual-capture/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export GATEWAY_API_URL="https://gateway.example.com/v1"
export GATEWAY_API_KEY="..."
export DRY_RUN="true"

python charged-amount-stale-after-manual-capture/python/reconcile_charged_amount.py
node   charged-amount-stale-after-manual-capture/node/reconcile-charged-amount.js
```

`classify_charge_reconciliation` (Python) / `classifyChargeReconciliation` (Node) is a pure function: given a Saleor transaction's charged and pending amounts plus its events, and the gateway's authoritative capture status, it returns `IN_SYNC`, `NEEDS_REPORT_SUCCESS`, `NEEDS_REPORT_FAILURE`, or `AMOUNT_MISMATCH_FLAG`. Only `NEEDS_REPORT_SUCCESS` and `NEEDS_REPORT_FAILURE` result in a `transactionEventReport` call, which is idempotent by `pspReference`, `type`, and `amount`, so it is safe to retry. `AMOUNT_MISMATCH_FLAG` is only ever logged for a human to review. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest charged-amount-stale-after-manual-capture/python
node --test charged-amount-stale-after-manual-capture/node
```
