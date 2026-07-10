# Editing a confirmed order reverts it to draft status

Editing a confirmed Saleor order, a line or a shipping address, can silently
flip `order.status` back to `DRAFT` instead of rejecting the edit, because the
dashboard and API have historically reused the same draft-order mutations
against placed orders. Since `OrderStatusFilter` has no `DRAFT` value, these
orders vanish from every normal `UNFULFILLED` or `READY_TO_FULFILL` queue even
though a `Payment` or `TransactionItem` record is still attached. This job
pages through every order with no status filter, flags any order sitting at
`DRAFT` that still carries an active or charged payment or a transaction, and
logs it for staff review.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/editing-order-reverts-to-draft/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python editing-order-reverts-to-draft/python/flag_orphaned_drafts.py
node   editing-order-reverts-to-draft/node/flag-orphaned-drafts.js
```

`is_orphaned_draft_with_payment` is a pure function: an order is flagged only
when its status is `DRAFT` and it also carries either an active payment whose
charge status is not `NOT_CHARGED`, or at least one transaction. That
combination is only reachable through the edit-reverts-to-draft defect, since
a legitimate fresh draft order never accumulates a captured payment before
`draftOrderComplete` runs.

This script never calls `draftOrderComplete` or `orderCancel` on its own.
There is no safe generic way to "un-revert" an order, since Saleor exposes no
reverse of `draftOrderComplete`. Only wire in the guarded `complete_draft_order`
/ `completeDraftOrder` helper yourself, after a human has reviewed the line
and address diff on the flagged order, and only with `DRY_RUN=false`.

## Test

```bash
pytest editing-order-reverts-to-draft/python
node --test editing-order-reverts-to-draft/node
```
