# Gift card order blocks unfulfill and delete

An order that contains a gift card line becomes non-reversible once it is fulfilled. Fulfilling that line issues a live, spendable `GiftCard` record, so Saleor's own mutations refuse to unwind it: `orderFulfillmentCancel` raises `CANNOT_CANCEL_FULFILLMENT` for any fulfillment on the order, and `orderLineDelete` / `orderLineUpdate` raise `NON_REMOVABLE_GIFT_LINE` / `NON_EDITABLE_GIFT_LINE` for the gift card line itself. There is no override mutation for any of this, by design. This script pages through orders, flags the ones a lifecycle mutation would block, and reports the exact error code, never forcing the cancel or the delete.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/gift-card-order-blocks-unfulfill-delete/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python gift-card-order-blocks-unfulfill-delete/python/flag_gift_card_blocks.py
node   gift-card-order-blocks-unfulfill-delete/node/flag-gift-card-blocks.js
```

`classify_gift_card_order_block` (`classifyGiftCardOrderBlock` in Node) is a pure function: it takes a plain order shape and returns `{blocked, blockingCode, reason}` without touching the network. An order is blocked with `CANNOT_CANCEL_FULFILLMENT` when it has gift cards linked and any fulfillment is `FULFILLED`, `PARTIALLY_FULFILLED`, or `WAITING_FOR_APPROVAL`. It is blocked with `NON_REMOVABLE_GIFT_LINE` when any line has `isGift` true. Otherwise it is not blocked.

The script never calls `orderFulfillmentCancel`, `orderLineDelete`, `orderLineUpdate`, or `orderDelete` against a gift-card-line order, guarded or not. The only write path included (`deactivate_gift_card` / `add_reconciliation_note`, opt-in, never called by `run()`) deactivates the specific gift card with `giftCardDeactivate` and adds a note with `orderNoteAdd`, for use only after a human has confirmed the refund is handled out of band through the payment gateway. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest gift-card-order-blocks-unfulfill-delete/python
node --test gift-card-order-blocks-unfulfill-delete/node
```
