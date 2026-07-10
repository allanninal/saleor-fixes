# Order can be charged more than its total

Saleor tracks `authorizedAmount` and `chargedAmount` independently on every `TransactionItem` and aggregates them onto the order as `totalCharged` and `totalAuthorized`, with no database constraint capping that sum against `order.total`. A buggy payment app, a double-delivered webhook, or more than one `TransactionItem` attached to the same order can each look valid on its own while together pushing the order over its total, a state Saleor surfaces as the `OVERCHARGED` value of `order.chargeStatus`. This job pages through orders with their transactions and total, flags every order where `totalCharged + totalAuthorized` exceeds `total.gross.amount` past a small rounding tolerance, and logs a proposed `orderGrantedRefundCreate` input for a human to review. It never calls the refund mutations itself.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/order-charged-more-than-total/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export OVERCHARGE_EPSILON="0.005"
export DRY_RUN="true"

python order-charged-more-than-total/python/flag_overcharged_orders.py
node   order-charged-more-than-total/node/flag-overcharged-orders.js
```

`decide_overcharge_flag` is a pure function: it sums `chargedAmount` plus `authorizedAmount` across the passed-in transactions (falling back to `order.totalCharged` / `order.totalAuthorized` when that array is empty), compares the sum to `order.totalGrossAmount` with a small epsilon for rounding, and returns whether it is overcharged along with the raw sum and the overage. The script only ever logs a report entry and a proposed granted refund input. Reversing real captured money needs a human decision, so creating an actual `orderGrantedRefundCreate` or calling `transactionRequestRefundForGrantedRefund` is left as an opt-in step you wire in yourself once someone has approved the amount, and even then it should stay behind `DRY_RUN=false`.

## Test

```bash
pytest order-charged-more-than-total/python
node --test order-charged-more-than-total/node
```
