# Duplicate stock checks still allow double selling

Saleor validates requested quantity against available stock independently at `checkoutCreate`, `checkoutLinesAdd`, `checkoutShippingAddressUpdate`, and `checkoutComplete`, reading the current `Stock.quantity` minus reservations at that instant rather than holding one locked reservation for the whole flow. Two concurrent checkouts for the same variant, or a stale checkout revalidated later, can each pass every check on its own while their combined demand oversells the SKU. This script never edits stock or cancels an order: it cross checks orders and warehouse stock and reports every oversold SKU and warehouse pair with the offending order ids, for a human to action.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/duplicate-stock-checks-allow-oversell/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export ORDER_WINDOW_DAYS="7"
export DRY_RUN="true"

python duplicate-stock-checks-allow-oversell/python/find_oversold.py
node   duplicate-stock-checks-allow-oversell/node/find-oversold.js
```

`find_oversold_lines` is a pure function: for every SKU and warehouse pair it sums the allocated quantity from non-cancelled orders and compares it against the physical on hand stock, flagging the pair when recomputed demand exceeds on hand stock or when Saleor's own reported `quantityAllocated` disagrees with the recomputed sum. The script only ever prints a report row per oversold pair, with the offending order ids attached. It never calls `stockBulkUpdate`, `orderCancel`, or `orderFulfillmentCancel` itself, those are human decisions.

## Test

```bash
pytest duplicate-stock-checks-allow-oversell/python
node --test duplicate-stock-checks-allow-oversell/node
```
