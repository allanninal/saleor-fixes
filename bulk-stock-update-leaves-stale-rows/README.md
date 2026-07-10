# Bulk stock update leaves stale or partial rows

Saleor's bulk stock mutations, `productVariantStocksUpdate` and `stockBulkUpdate`, take a list of per-warehouse rows and process the whole batch in one call, but error handling is row-scoped via an `errorPolicy`. The default `REJECT_EVERYTHING` rolls back the entire batch on any single bad row, while `REJECT_FAILED_ROWS` and `IGNORE_FAILED_ROWS` deliberately persist only the valid rows. Either way, a script that fires one bulk call and assumes every warehouse updated can end up with `Stock` rows still holding their pre-update quantity.

This reconciler reads back real per-warehouse stock, diffs the intended quantity against the actual quantity for every row, and only auto-repairs the rows a genuine failed-row error explains, never the whole original batch.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/bulk-stock-update-leaves-stale-rows/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python bulk-stock-update-leaves-stale-rows/python/reconcile_bulk_stock.py
node   bulk-stock-update-leaves-stale-rows/node/reconcile-bulk-stock.js
```

`diff_stock_rows` is a pure function: it takes the intended rows, the actual rows read back from Saleor, and any mutation errors captured, and returns a status per row of `ok`, `stale`, or `reported_error`. The script only reports by default. With `DRY_RUN=false` it re-issues a new, scoped `stockBulkUpdate` for just the stale rows explained by a repairable error code (`NOT_FOUND`, `INVALID`), then re-reads and re-diffs to confirm convergence. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest bulk-stock-update-leaves-stale-rows/python
node --test bulk-stock-update-leaves-stale-rows/node
```
