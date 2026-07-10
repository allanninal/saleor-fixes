# Guest checkout order not linked to matching customer account

Saleor links `order.user` to a registered `User` only when the checkout itself was performed while logged in, read from the checkout's own `user_id` at completion time, not from its email. A guest checkout stores the buyer's email on `order.userEmail` but leaves `order.user` null, even when that email exactly matches an existing account, because Saleor deliberately never runs a post-hoc lookup against the `User` table by email. Auto-linking by email alone would let anyone claim another account's order history just by entering their email at guest checkout.

This script pages through `orders` and `customers`, cross-references unlinked guest orders against registered customer emails with a pure function, and reports every match for staff review. It never writes `order.user`.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/guest-order-not-linked-to-customer/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export REPORT_PATH="unlinked_guest_orders.csv"
export DRY_RUN="true"

python guest-order-not-linked-to-customer/python/find_unlinked_guest_orders.py
node   guest-order-not-linked-to-customer/node/find-unlinked-guest-orders.js
```

`find_unlinked_guest_orders` (Python) / `findUnlinkedGuestOrders` (Node) is a pure function: it builds a map of lowercased, trimmed customer email to customer id, then flags orders where `user` is null, `userEmail` is non-empty, and the normalized email exists in that map. It never calls a mutation. Under `DRY_RUN=true` (the default) the script only logs the report; under `DRY_RUN=false` it additionally writes a CSV report file for staff review. Attaching a customer to an existing order should only ever happen through a staff-confirmed manual `orderUpdate`, never an automatic write.

## Test

```bash
pytest guest-order-not-linked-to-customer/python
node --test guest-order-not-linked-to-customer/node
```
