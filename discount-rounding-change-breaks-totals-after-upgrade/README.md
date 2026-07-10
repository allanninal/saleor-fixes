# Discount rounding change breaks totals after upgrade

Saleor 3.12 changed the decimal quantization mode used to compute percentage-discount amounts from `ROUND_DOWN` to `ROUND_HALF_UP`. Orders and checkouts whose totals were persisted under 3.11, or that still carry a stale cached discount amount, no longer match what the same percentage voucher would compute today, because the last cent now rounds up instead of truncating down. This only affects `PERCENTAGE`-type vouchers. This script recomputes the expected discount under the current rounding rule and flags any order or checkout whose persisted discount does not match, without ever rewriting a financial record.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/discount-rounding-change-breaks-totals-after-upgrade/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DEPLOY_DATE_ISO="2026-01-15T00:00:00Z"
export DRY_RUN="true"

python discount-rounding-change-breaks-totals-after-upgrade/python/discount_rounding_drift.py
node   discount-rounding-change-breaks-totals-after-upgrade/node/discount-rounding-drift.js
```

`computeDiscountDrift` is a pure function: given the undiscounted amount, the voucher's discount value type and value, and the persisted discount amount, it returns the expected discount, the delta, and whether it drifted. `FIXED` vouchers are rounding-mode-invariant and are never flagged. Placed and paid orders are only ever reported for finance review. Only a still-open, unpaid checkout can be safely repaired, by removing and reapplying the same voucher code so Saleor's own current pricing logic recomputes the total server side. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest discount-rounding-change-breaks-totals-after-upgrade/python
node --test discount-rounding-change-breaks-totals-after-upgrade/node
```
