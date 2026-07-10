# Gift card balance update overwrites initial balance

Saleor's `giftCardUpdate` mutation has a single `balanceAmount` field on `GiftCardUpdateInput`, and whatever amount you pass gets written to both `initialBalance` and `currentBalance` in one write. There is no separate top-up field and no server-side check for whether the card has already been spent down. A call meant to top up only the remaining balance on an active, partially-used card ends up resetting `currentBalance` back up to match the new `initialBalance`, silently erasing the spend recorded in the card's `GiftCardEvent`s.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/gift-card-balance-update-overwrites-initial/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python gift-card-balance-update-overwrites-initial/python/audit_gift_card_balances.py
node   gift-card-balance-update-overwrites-initial/node/audit-gift-card-balances.js
```

`classify_gift_card_balance_overwrite` is a pure function: it takes a card's balances and a plain list of its events and returns a classification. A card is flagged as affected when either `currentBalance` is greater than `initialBalance` (a literal anomaly that can never happen legitimately, and is unrecoverable from the current state alone), or when an `UPDATED` event shows the balance had already diverged before a write that collapsed both fields to one number (in which case the event's own `oldCurrentBalance` is the recovered last known-good figure).

This script never writes a corrected balance. Saleor keeps no separate ledger column, so the only safe lever is to report the recovered figure for each affected card and hand that report to staff for a confirmed manual correction. Start with `DRY_RUN=true` (the default) to review the report first.

## Test

```bash
pytest gift-card-balance-update-overwrites-initial/python
node --test gift-card-balance-update-overwrites-initial/node
```
