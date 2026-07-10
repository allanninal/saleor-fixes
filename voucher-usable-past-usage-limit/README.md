# Voucher usable past its usage limit

Saleor increments a voucher's `used` counter only after checkout or order completion, and the check that `used` is still below `usageLimit` is not atomically guarded against a second completion doing the same read at nearly the same instant. Under concurrent completion, two checkouts can both pass the check before either write lands, pushing `used` above `usageLimit`. A retried `checkoutComplete` across a 3DS payment confirmation can also double count one redemption.

Rolling back a completed, paid order to unwind an over-redeemed voucher is a business decision, so this is flag and report, not auto-fix. The script pages every voucher with a `usageLimit`, cross-checks it against real non-draft, non-canceled orders, and reports the true overage with the affected order ids for staff review.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/voucher-usable-past-usage-limit/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python voucher-usable-past-usage-limit/python/detect_voucher_overage.py
node   voucher-usable-past-usage-limit/node/detect-voucher-overage.js
```

`detect_voucher_overage` is a pure function: it takes a voucher and the orders that reference it, filters out draft and canceled orders, and returns a report only when the true redemption count exceeds `usageLimit` or when Saleor's own `used` already disagrees with the limit. It never cancels, refunds, or re-charges an order. With `DRY_RUN=true` (the default) it only logs the report. With `DRY_RUN=false` the only write is stopping further redemptions on the flagged voucher by setting `endDate` to now; the affected order ids still go to staff for manual resolution.

## Test

```bash
pytest voucher-usable-past-usage-limit/python
node --test voucher-usable-past-usage-limit/node
```
