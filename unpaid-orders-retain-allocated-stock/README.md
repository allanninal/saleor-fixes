# Unpaid orders keep stock allocated indefinitely

Saleor allocates warehouse stock the moment an order line is created at checkout completion, but the only built-in mechanism that ever releases it automatically is a Celery beat task tied to the per-channel `OrderSettings.expireOrdersAfter` setting, and that task only touches orders still in `UNCONFIRMED` status with no payment transaction attached. `expireOrdersAfter` defaults to `null`, so unless a merchant configures it per channel, an unpaid order and its stock allocation sit untouched indefinitely.

This job pages through orders, classifies each one with a pure decision function, cancels the safe tier (`UNCONFIRMED` or fully `UNFULFILLED`, nothing shipped) with `orderCancel`, and only ever flags `PARTIALLY_FULFILLED` orders for a human to review, since part of those already shipped and cancelling them outright would orphan the fulfillment.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/unpaid-orders-retain-allocated-stock/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export STALE_AFTER_HOURS="72"
export DRY_RUN="true"

python unpaid-orders-retain-allocated-stock/python/reconcile_stuck_orders.py
node   unpaid-orders-retain-allocated-stock/node/reconcile-stuck-orders.js
```

`classify_stuck_order` is a pure function (the current time is passed in): it returns `OK` for anything already paid or already resolved (cancelled, expired, fulfilled), `OK` for a still-fresh `UNCONFIRMED` order whose channel has native expiration configured and has not yet elapsed, `CANCEL` for stale unpaid orders that are `UNCONFIRMED` or fully `UNFULFILLED`, and `DEALLOCATE_ONLY` for stale unpaid `PARTIALLY_FULFILLED` orders. Only the `CANCEL` tier is ever written automatically, and only when `DRY_RUN=false`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest unpaid-orders-retain-allocated-stock/python
node --test unpaid-orders-retain-allocated-stock/node
```
