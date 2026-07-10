# Entire order percentage voucher discount miscalculated

Saleor documents an `ENTIRE_ORDER` percentage voucher discount as applying to the subtotal, the sum of line prices after any catalogue Promotion has already reduced them. In affected versions the order-discount pipeline instead sourced its base amount from the undiscounted total, so a product that also carried an active catalogue Promotion had the voucher computed against its pre-promotion price. The two percentage discounts then stacked additively instead of compounding, tracked as [Saleor GitHub issue #17453](https://github.com/saleor/saleor/issues/17453), which also reported non-deterministic totals on otherwise-identical orders.

This script pages through orders carrying an `ENTIRE_ORDER` percentage voucher, recomputes the expected discount from the documented formula against the subtotal Saleor reports, and flags any order whose applied discount does not match. It never rewrites an order, since Saleor has no mutation that accepts an arbitrary total override and rewriting a paid or fulfilled order's totals risks breaking reconciliation with a payment gateway or an accounting system.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/entire-order-percentage-voucher-miscalculated/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"

python entire-order-percentage-voucher-miscalculated/python/flag_entire_order_voucher_mismatch.py
node   entire-order-percentage-voucher-miscalculated/node/flag-entire-order-voucher-mismatch.js
```

`compute_expected_entire_order_percentage_discount` is a pure function: given the already-discounted subtotal and the voucher's percentage, it returns the expected discount, capped so it can never drive the order below zero. `flag_order` compares that expected discount to what Saleor actually applied and reports a mismatch with the order number, expected discount, actual discount, delta, channel, and voucher id. This is a diagnostic only, it never writes to an order. Every finding is meant for finance and support review, and any correction on an already-paid order should go through a manual `orderDiscountAdd` or a payment adjustment approved by a human, never an automatic write.

## Test

```bash
pytest entire-order-percentage-voucher-miscalculated/python
node --test entire-order-percentage-voucher-miscalculated/node
```
