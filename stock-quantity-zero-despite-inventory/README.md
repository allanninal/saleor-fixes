# Stock quantity reads zero despite items in warehouse

`Stock.quantity` is a plain number that store staff, an import job, or a bulk mutation writes directly. It is not calculated from a physical count. If a variant was created without a `Stock` row properly attached to a warehouse, or a bulk import wrote `quantity=0` as a placeholder before a follow up update landed, the stored quantity drifts from the real shelf count and `quantityAvailable` reports out of stock even though units are physically present. This script pages through variants and stock, compares `quantity` against summed live `Allocation` rows and any known physical count you supply, and reports every variant and warehouse pair where the numbers do not add up. It never overwrites inventory without a confirmed count.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/stock-quantity-zero-despite-inventory/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export SALEOR_CHANNEL="default-channel"
export DRY_RUN="true"

python stock-quantity-zero-despite-inventory/python/detect_stock_drift.py
node   stock-quantity-zero-despite-inventory/node/detect-stock-drift.js
```

`detect_stock_drift` (Python) and `detectStockDrift` (Node) are pure functions: given a stock row, its live allocations, and an optional known physical count, they return `{isDrift, delta, reason}` with no network calls. A pair is flagged when allocations exceed the stored quantity, when a supplied physical count is higher than the stored quantity, or when quantity is zero while open allocations exist.

Under `DRY_RUN=true` (the default) the script only reports flagged pairs. When `DRY_RUN=false` and you supply a confirmed physical count per variant and warehouse, it calls `stockBulkUpdate` one pair at a time and re-queries `quantityAvailable` to confirm the drift resolved before moving to the next pair. It never guesses a corrected quantity on its own.

## Test

```bash
pytest stock-quantity-zero-despite-inventory/python
node --test stock-quantity-zero-despite-inventory/node
```
