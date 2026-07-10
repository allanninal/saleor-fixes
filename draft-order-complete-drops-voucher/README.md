# draftOrderComplete drops the applied voucher

A draft order can carry a valid voucher and a correct discounted total right up until `draftOrderComplete` runs a fresh price recalculation. That recalculation is re-derived from the order's stored voucher and voucherCode reference, and it has historically failed to do that consistently, dropping the discount outright or recomputing it against the wrong base. This tool snapshots a draft order before and after completion and diffs the two so a dropped or shrunk voucher discount is a logged finding, not a silent gap finance discovers later.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/draft-order-complete-drops-voucher/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"

python draft-order-complete-drops-voucher/python/detect_dropped_voucher.py
node   draft-order-complete-drops-voucher/node/detect-dropped-voucher.js
```

`diff_voucher_discount` (Python) / `diffVoucherDiscount` (Node) is a pure function: given a draft order snapshot and a completed order snapshot, it flags the order only when the draft had a voucher, a real discount existed, and the completed order either lost the voucher code or ended up with a materially smaller discount than the draft, beyond a small rounding tolerance.

There is no safe auto-fix. Re-adding a discount with `orderDiscountAdd` after completion can desync the order total from a Transaction or Payment amount that already moved, so the script only prepares that call and never executes it unless a human explicitly sets `DRY_RUN=false` after reviewing the report.

## Test

```bash
pytest draft-order-complete-drops-voucher/python
node --test draft-order-complete-drops-voucher/node
```
