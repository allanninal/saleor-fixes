# Order stuck unfulfilled after payment succeeds

`order.status` in Saleor is driven purely by whether `Fulfillment` records exist for the order's lines, completely decoupled from `isPaid` or `paymentStatus`. Capturing a payment, through `orderMarkAsPaid`, a `TransactionItem` charge, or a payment app, only updates the paid or charged state. It never calls the fulfillment logic itself. Only an explicit `orderFulfill` call, usually triggered by staff in the dashboard or an app reacting to an `ORDER_CONFIRMED` or `ORDER_FULLY_PAID` webhook, ever creates a fulfillment. If that webhook is missing, mis-scoped, erroring, or the receiving app is down, the order sits correctly paid and permanently `UNFULFILLED` with no built-in retry or timeout.

This script pages through orders, flags the ones that are paid, unfulfilled, have no active fulfillment, and are older than a staleness threshold, and reports them for staff triage. It never auto-fulfills by default, since creating a fulfillment for an order nobody has picked or packed risks shipping something that was never staged.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/order-stuck-unfulfilled-after-payment/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export STALE_AFTER_MINUTES="30"
export DRY_RUN="true"

python order-stuck-unfulfilled-after-payment/python/flag_stuck_unfulfilled.py
node   order-stuck-unfulfilled-after-payment/node/flag-stuck-unfulfilled.js
```

`classify_stuck_order` / `classifyStuckOrder` is a pure function (the current time is passed in): an order is flagged only when it is `UNFULFILLED`, paid (`isPaid` true or a `FULLY_CHARGED`/`PARTIALLY_CHARGED` payment status), has no active (non-cancelled) fulfillment, and has aged past `STALE_AFTER_MINUTES` since its last update. The only output is a report entry (`orderId`, `number`, `channel`, `paidAmount`, `ageMinutes`) logged for staff triage. It never calls `orderFulfill` from the default path. A guarded, opt-in `fulfillOrder`/`fulfill_order` helper is included for teams that explicitly want auto-repair on a known-safe scenario (for example digital or gift-card-only orders), but it is never called by `run()` and should only ever run with fresh stock data and `DRY_RUN=false`.

## Test

```bash
pytest order-stuck-unfulfilled-after-payment/python
node --test order-stuck-unfulfilled-after-payment/node
```
