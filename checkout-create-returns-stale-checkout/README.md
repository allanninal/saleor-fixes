# checkoutCreate returns a stale existing checkout

Saleor 3.x always inserts a new `Checkout` row from `checkoutCreate` and never auto-reuses one (that dedup logic was removed after Saleor 2.x, see GitHub issue 6185). So when a shopper gets old lines, an expired voucher, or someone else's cart back, the real bug is almost always the storefront or app replaying a saved checkout token instead of asking for a new one. This script pages through open checkouts, checks each one's voucher and lines against current store state, and flags any checkout that looks like a stale reused one, with the reasons attached.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/checkout-create-returns-stale-checkout/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export MAX_IDLE_HOURS="24"
export DRY_RUN="true"

python checkout-create-returns-stale-checkout/python/flag_stale_checkout.py
node   checkout-create-returns-stale-checkout/node/flag-stale-checkout.js
```

`classify_stale_checkout` is a pure function (all checkout data, voucher status, and channel listing status are pre-fetched and passed in, including the current time): a checkout is flagged stale when its stored session metadata does not match an expected session id, its voucher code is no longer active, one of its lines points at a variant with no channel listing left, or it has sat idle past `MAX_IDLE_HOURS`. This script never mutates a checkout, removes a voucher, or detaches a user. It only reports. `DRY_RUN` is kept for consistency with the other fixes in this repo.

## Test

```bash
pytest checkout-create-returns-stale-checkout/python
node --test checkout-create-returns-stale-checkout/node
```
