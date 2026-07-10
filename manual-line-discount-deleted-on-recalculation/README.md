# Manual order line discount deleted on recalculation

Saleor recalculates draft and unconfirmed order prices lazily, through `fetch_order_prices_if_expired`. Any mutation that touches the order, `orderLinesCreate`, `orderLineUpdate`, an `orderUpdate` that changes the shipping or billing address, `orderShippingMethodUpdate`, or applying a voucher, can trigger that pass, re-deriving each line's unit price from the undiscounted price plus whatever catalogue promotions and vouchers currently apply. A manually applied line discount, set with `orderLineDiscountUpdate` and stored as `unitDiscountType` / `unitDiscountValue` / `unitDiscountReason`, is supposed to take precedence over that, but if its flag was not correctly carried through the update, the recalculation falls back to standard pricing and silently clears the discount, with no error surfaced (see [saleor/saleor#4675](https://github.com/saleor/saleor/issues/4675)).

This script snapshots an order's lines before and after a recalculation-triggering mutation, flags any line whose manual discount silently disappeared, and reports it. It never blind-restores a discount, since a legitimate price change between snapshots could make the old value wrong. A restore only happens under `DRY_RUN=false`, using the exact `valueType`, `value`, and `reason` captured in the snapshot, and is meant to run only after a human has confirmed the loss is a regression.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/manual-line-discount-deleted-on-recalculation/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export ORDER_ID="the order's global ID"
export DRY_RUN="true"

python manual-line-discount-deleted-on-recalculation/python/detect_discount_loss.py
node   manual-line-discount-deleted-on-recalculation/node/detect-discount-loss.js
```

Both entry points call `run(order_id, mutate_fn)` / `run(orderId, mutateFn)`, where `mutate_fn` / `mutateFn` is a caller-supplied function that performs whatever mutation you suspect of triggering recalculation (an `orderLinesCreate`, an address change, a voucher application, and so on). The script snapshots the order's lines before calling it and again after, then flags any line where a manual discount disappeared.

`decide_discount_loss` / `decideDiscountLoss` is a pure function: it takes a line's before and after snapshot (`unitDiscountValue`, `unitDiscountType`, `unitDiscountReason`, `unitPriceGrossAmount`) and returns `{ lost, shouldFlag, restoreInput }`. It flags a loss only when the line had a manual discount before (a positive value or a non-null reason) and both the value and the reason are gone after. `restoreInput` is populated only when a loss is detected, using the exact fields from the `before` snapshot, so a real restore call never has to guess a value. No network or DB calls happen inside it, so it needs no Saleor account to test.

Under `DRY_RUN=true` (the default), flagged lines are only logged, nothing is written. Under `DRY_RUN=false`, the script calls `orderLineDiscountUpdate` with the captured `restoreInput` for every flagged line, so only flip that off once a person has reviewed the report and confirmed nothing else about the order's pricing legitimately changed in between.

## Test

```bash
pytest manual-line-discount-deleted-on-recalculation/python
node --test manual-line-discount-deleted-on-recalculation/node
```
