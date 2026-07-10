# Gift card balance not restored on order cancellation

Cancelling a Saleor order releases stock and marks the order `CANCELED`, but it never runs any compensating logic against a gift card's `currentBalance`. Debiting a gift card happens inside payment processing, recorded as a `GiftCardEvent` of type `USED_IN_ORDER`, which is decoupled from order status transitions, so cancellation never fires a signal to reverse it. This script finds cancelled orders that used a gift card, cross-references each card's event history for an un-reversed debit, and restores the balance with `giftCardUpdate`, capped at the card's own initial balance.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/gift-card-balance-not-restored-on-cancel/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python gift-card-balance-not-restored-on-cancel/python/restore_gift_card_balance.py
node   gift-card-balance-not-restored-on-cancel/node/restore-gift-card-balance.js
```

`plan_gift_card_restoration` is a pure function: for a `CANCELED` order, it restores each un-reversed gift card usage to `currentBalanceAmount + amountUsed`, capped at `initialBalanceAmount`. If the uncapped total would exceed the initial balance by more than a small rounding epsilon, it skips that usage as an anomaly instead of silently clamping it. Because `giftCardUpdate`'s `balanceAmount` is a hard overwrite, the script always writes the freshly computed absolute amount and re-fetches the card immediately before writing to avoid a lost update. Start with `DRY_RUN=true` to review the planned restorations first.

## Test

```bash
pytest gift-card-balance-not-restored-on-cancel/python
node --test gift-card-balance-not-restored-on-cancel/node
```
