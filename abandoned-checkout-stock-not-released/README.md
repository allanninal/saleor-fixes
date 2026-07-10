# Abandoned checkout keeps stock reserved past TTL

Saleor's optional stock reservation feature allocates warehouse stock to a checkout the moment items are added, and that reservation is only cleared by a periodic Celery beat task. If that task queue is misconfigured, delayed, or the worker is down, expired reservation rows are never deleted, so `Stock.quantity` stays debited by phantom holds from carts nobody will finish. This job lists checkouts, flags the ones whose `stockReservationExpires` is already in the past or whose `lastChange` is older than `CHECKOUT_TTL_BEFORE_RELEASING_FUNDS` (default 6h), and calls `checkoutLinesDelete` to strip the lines from the flagged checkout so Saleor drops the associated reservation.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/abandoned-checkout-stock-not-released/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export TTL_MINUTES="360"
export DRY_RUN="true"

python abandoned-checkout-stock-not-released/python/release_stale_reservations.py
node   abandoned-checkout-stock-not-released/node/release-stale-reservations.js
```

`find_stale_reserved_checkouts` is a pure function (the current time is passed in): a checkout is flagged only when its `stockReservationExpires` has passed, or otherwise when its `lastChange` is older than the TTL window. The only write is `checkoutLinesDelete` on the flagged lines, so it never mutates `Stock.quantity` or allocations directly, and it never touches the checkout's order or payment records. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest abandoned-checkout-stock-not-released/python
node --test abandoned-checkout-stock-not-released/node
```
