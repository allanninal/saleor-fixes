# Paid checkout never converts to an order

A card gets charged, the payment provider confirms it, and Saleor's `authorizeStatus` on the Checkout reaches `FULL`, but no Order ever appears. `checkoutComplete` is a separate mutation the storefront must call after payment confirms, so if the tab closes, the app crashes, or the network drops in that gap, the Checkout is left behind with money captured and no Order. This job lists checkouts with `authorizeStatus: FULL`, keeps the ones aged past a short grace period with no Order yet, and calls `checkoutComplete` for each. Anything still needing a 3DS or redirect confirmation is flagged for a human instead of being forced.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/paid-checkout-never-converts-to-order/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export GRACE_MINUTES="5"
export DRY_RUN="true"

python paid-checkout-never-converts-to-order/python/complete_paid_checkouts.py
node   paid-checkout-never-converts-to-order/node/complete-paid-checkouts.js
```

`should_complete_checkout` / `shouldCompleteCheckout` is a pure function (the current time is passed in): a checkout is completed only when `authorizeStatus` is `FULL`, it has no Order yet, and it is older than the grace period. If the charge status still looks pending or partial on the provider side, it is flagged instead of completed, since that usually means a 3DS or redirect step is still outstanding. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest paid-checkout-never-converts-to-order/python
node --test paid-checkout-never-converts-to-order/node
```
