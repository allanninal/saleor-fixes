# Concurrent checkouts oversell the same stock

Two checkouts for the same SKU can race through Saleor's check-then-allocate stock flow at nearly the same time. Both read the same available quantity, both complete, and the sum of `Allocation.quantityAllocated` ends up higher than `Stock.quantity` for that variant and warehouse (see [saleor/saleor#543](https://github.com/saleor/saleor/issues/543)). Stock reservations narrow the window but do not close it, since reservations only cover the checkout-in-progress window and expire on a timer.

This script never rewrites stock or cancels an order. It pages through variants and their per-warehouse stock, flags every pair where `quantityAllocated > quantity`, cross-checks against unfulfilled order allocations to list the affected order IDs, and prints a suggested `stockBulkUpdate` payload as a proposal only. Deciding which order loses inventory is a human, business-level call.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/concurrent-checkouts-oversell-stock/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export SALEOR_CHANNEL="default-channel"
export DRY_RUN="true"

python concurrent-checkouts-oversell-stock/python/find_oversold_stock.py
node   concurrent-checkouts-oversell-stock/node/find-oversold-stock.js
```

`find_oversold_stocks` (Python) / `findOversoldStocks` (Node) is a pure function: it takes the already-fetched stock snapshot array, computes `delta = quantityAllocated - quantity` per row, and returns only the oversold rows sorted by delta descending. It does no I/O and never decides how to fix an oversell. The script only reports; it never calls `stockBulkUpdate` or `orderCancel` automatically, even with `DRY_RUN=false`.

## Test

```bash
pytest concurrent-checkouts-oversell-stock/python
node --test concurrent-checkouts-oversell-stock/node
```
