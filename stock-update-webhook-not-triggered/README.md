# Stock update webhook not triggered on some mutations

`PRODUCT_VARIANT_STOCK_UPDATED` only fires from `productVariantStocksUpdate`, `stockBulkUpdate`, and `productVariantStocksCreate`/`Delete`, the mutations that were explicitly wired to call `stock_bulk_updated`. Quantity changes from `orderFulfill` deallocating and decrementing stock, order cancellation or refund restoring it, and draft order completion all mutate `Stock.quantity` directly through allocation helper functions that were never hooked up to fire the event, so no webhook delivery is ever created even though the quantity genuinely changed. This job snapshots ground truth stock on an interval, diffs it against the previous snapshot, checks the app's own webhook delivery log for a matching `PRODUCT_VARIANT_STOCK_UPDATED` delivery in the same window, and classifies every unmatched delta as a desync so a human can review it.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/stock-update-webhook-not-triggered/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export SALEOR_WEBHOOK_ID="gid://saleor/Webhook/1"
export RECONCILE_ENDPOINT="https://your-app.example.com/inventory/reconcile"
export DRY_RUN="true"

python stock-update-webhook-not-triggered/python/detect_stock_webhook_desync.py
node   stock-update-webhook-not-triggered/node/detect-stock-webhook-desync.js
```

`classify_stock_desync` is a pure function: a delta is desynced only when the quantity actually changed and no matching webhook delivery was found for that window. Severity is `critical` when the recent mutation hint is `ORDER_FULFILL` or `ORDER_CANCEL`, known non-emitting paths, or when the delta is large or crosses a zero boundary, otherwise it is `warn`. There is no Saleor mutation that replays a past async event, so this script never tries to re-fire a webhook. Under `DRY_RUN=true` (the default) it only logs the flagged pairs. When `DRY_RUN=false` it POSTs a synthetic reconciliation payload, shaped like the real webhook payload, to your own external endpoint. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest stock-update-webhook-not-triggered/python
node --test stock-update-webhook-not-triggered/node
```
