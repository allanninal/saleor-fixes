# Saleor Fixes

Small, tested Python and Node.js scripts that detect and repair real problems on **Saleor** stores. Products missing a channel listing or price, warehouse and stock drift, checkouts that never convert, orders stuck unfulfilled, payment and refund mismatches, voucher and gift card bugs, and webhooks stuck failed.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/saleor](https://www.allanninal.dev/saleor/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
[![Tests](https://github.com/allanninal/saleor-fixes/actions/workflows/tests.yml/badge.svg)](https://github.com/allanninal/saleor-fixes/actions/workflows/tests.yml)

## How the scripts work

Saleor has a single **GraphQL endpoint** (`POST /graphql/`). The scripts send an `Authorization: Bearer` token (an app token or staff JWT) and run queries and mutations. Node uses the built-in `fetch`; Python uses `requests`. The decision logic in every fix is a pure function with no I/O, so it is unit tested.

## Setup

Set the environment variables a fix needs. Use an app token or a staff JWT with the permissions a fix needs.

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"   # start safe
```

Python needs `pip install requests pytest`. Node needs Node 18 or newer (the scripts use the built-in `fetch`, no packages).

## The fixes

| Fix | What it does | Type | Guide |
|---|---|---|---|
| [paid-checkout-never-converts-to-order](./paid-checkout-never-converts-to-order/) | Browser closes after payment succeeds but before checkoutComplete runs, leaving a paid checkout orphaned. Script finds and completes them. | Reconciler | [Read](https://www.allanninal.dev/saleor/paid-checkout-never-converts-to-order/) |
| [abandoned-checkout-stock-not-released](./abandoned-checkout-stock-not-released/) | CHECKOUT_TTL_BEFORE_RELEASING_FUNDS not enforced, leaving stale reservations. Script finds and releases expired checkout stock. | Repair | [Read](https://www.allanninal.dev/saleor/abandoned-checkout-stock-not-released/) |
| [concurrent-checkouts-oversell-stock](./concurrent-checkouts-oversell-stock/) | Simultaneous checkouts allocate more units than exist for a SKU. Script audits allocated versus on-hand stock per warehouse. | Diagnostic | [Read](https://www.allanninal.dev/saleor/concurrent-checkouts-oversell-stock/) |
| [duplicate-stock-checks-allow-oversell](./duplicate-stock-checks-allow-oversell/) | Repeated validation at checkout create and address update passes even at twice available stock. Script cross checks order line quantity against warehouse stock. | Diagnostic | [Read](https://www.allanninal.dev/saleor/duplicate-stock-checks-allow-oversell/) |
| [checkout-create-returns-stale-checkout](./checkout-create-returns-stale-checkout/) | New checkout requests reuse an old open checkout, carrying stale lines or vouchers. Script detects checkouts reused across sessions with mismatched metadata. | Diagnostic | [Read](https://www.allanninal.dev/saleor/checkout-create-returns-stale-checkout/) |
| [checkout-lines-add-fails-no-country](./checkout-lines-add-fails-no-country/) | checkoutLinesAdd errors for anonymous carts lacking a shipping country when click and collect is off. Script reproduces via API to flag misconfigured channels. | Diagnostic | [Read](https://www.allanninal.dev/saleor/checkout-lines-add-fails-no-country/) |
| [product-unavailable-warehouse-zone-channel-mismatch](./product-unavailable-warehouse-zone-channel-mismatch/) | Warehouse not linked to the customer's shipping zone and channel combo makes an in-stock product unbuyable. Script cross checks warehouse zone channel links. | Diagnostic | [Read](https://www.allanninal.dev/saleor/product-unavailable-warehouse-zone-channel-mismatch/) |
| [warehouse-zone-assignment-needs-shared-channel](./warehouse-zone-assignment-needs-shared-channel/) | Assigning a warehouse to a shipping zone silently fails when they share no channel. Script detects orphaned warehouse to zone links. | Diagnostic | [Read](https://www.allanninal.dev/saleor/warehouse-zone-assignment-needs-shared-channel/) |
| [no-shipping-methods-for-channel](./no-shipping-methods-for-channel/) | Shipping method not listed for the checkout's channel yields an empty shipping list. Script finds channels with zero shipping method listings. | Reconciler | [Read](https://www.allanninal.dev/saleor/no-shipping-methods-for-channel/) |
| [shipping-methods-stale-after-address-change](./shipping-methods-stale-after-address-change/) | availableShippingMethods stays stale when the shipping address changes to a newly covered country. Script re-requests methods after address update to catch stale results. | Reconciler | [Read](https://www.allanninal.dev/saleor/shipping-methods-stale-after-address-change/) |
| [stock-quantity-zero-despite-inventory](./stock-quantity-zero-despite-inventory/) | Stock.quantity shows zero while the warehouse actually holds units, a data consistency bug. Script diffs stock against allocations to detect drift. | Reconciler | [Read](https://www.allanninal.dev/saleor/stock-quantity-zero-despite-inventory/) |
| [bulk-stock-update-leaves-stale-rows](./bulk-stock-update-leaves-stale-rows/) | productVariantStocksUpdate fails to fully update stock across all warehouses. Script compares intended versus actual per warehouse stock after bulk updates. | Reconciler | [Read](https://www.allanninal.dev/saleor/bulk-stock-update-leaves-stale-rows/) |
| [stock-update-webhook-not-triggered](./stock-update-webhook-not-triggered/) | PRODUCT_VARIANT_STOCK_UPDATED does not fire for certain stock changing mutations, desyncing external inventory. Script polls stock and diffs against webhook delivery logs. | Reconciler | [Read](https://www.allanninal.dev/saleor/stock-update-webhook-not-triggered/) |
| [unpaid-orders-retain-allocated-stock](./unpaid-orders-retain-allocated-stock/) | Orders with canceled or missing payment never auto cancel, holding allocated stock forever. Script finds aged unpaid orders and deallocates or cancels them. | Reconciler | [Read](https://www.allanninal.dev/saleor/unpaid-orders-retain-allocated-stock/) |
| [variant-missing-channel-listing](./variant-missing-channel-listing/) | New or bulk created variants can end up with zero channel listings, making them unsellable though the product is published. Script finds variants with no channel listing. | Reconciler | [Read](https://www.allanninal.dev/saleor/variant-missing-channel-listing/) |
| [product-invisible-missing-channel-price](./product-invisible-missing-channel-price/) | Variant published to a channel with no non-zero price stays invisible to storefronts. Script cross checks channel listing against variant price. | Diagnostic | [Read](https://www.allanninal.dev/saleor/product-invisible-missing-channel-price/) |
| [invalid-channel-slug-accepted-silently](./invalid-channel-slug-accepted-silently/) | Passing a nonexistent channel slug to a query or mutation silently returns empty or wrong results instead of erroring. Script validates slugs against the channel list before use. | Diagnostic | [Read](https://www.allanninal.dev/saleor/invalid-channel-slug-accepted-silently/) |
| [product-without-variant-crashes-queries](./product-without-variant-crashes-queries/) | Products created with zero variants cause crashes in storefront and checkout flows. Script scans products for missing default variants. | Diagnostic | [Read](https://www.allanninal.dev/saleor/product-without-variant-crashes-queries/) |
| [variant-pricing-null-without-channel-arg](./variant-pricing-null-without-channel-arg/) | Pricing queries that omit the channel slug return null, which scripts can mistake for an unpriced variant. Script re-queries per channel before flagging unpriced variants. | Diagnostic | [Read](https://www.allanninal.dev/saleor/variant-pricing-null-without-channel-arg/) |
| [variant-cost-price-miscalculation](./variant-cost-price-miscalculation/) | costPrice computes incorrectly when a variant has more than one stock record and an empty cost. Script recomputes cost and flags inconsistent variants. | Diagnostic | [Read](https://www.allanninal.dev/saleor/variant-cost-price-miscalculation/) |
| [order-stuck-unfulfilled-after-payment](./order-stuck-unfulfilled-after-payment/) | Order status never leaves UNFULFILLED even after a successful payment or fulfillment creation. Script queries paid orders with no fulfillment past a time threshold. | Diagnostic | [Read](https://www.allanninal.dev/saleor/order-stuck-unfulfilled-after-payment/) |
| [fulfillment-blocked-stock-equals-one](./fulfillment-blocked-stock-equals-one/) | orderFulfill misreports available stock and blocks fulfillment when a variant has exactly one unit. Script re-verifies stock against requested fulfillment quantity. | Diagnostic | [Read](https://www.allanninal.dev/saleor/fulfillment-blocked-stock-equals-one/) |
| [digital-products-not-auto-fulfilled](./digital-products-not-auto-fulfilled/) | automatic_fulfillment_digital_products is ignored for some orders, leaving digital only orders stuck unfulfilled. Script queries digital only orders still unfulfilled. | Diagnostic | [Read](https://www.allanninal.dev/saleor/digital-products-not-auto-fulfilled/) |
| [partial-fulfillment-breaks-zero-quantity-line](./partial-fulfillment-breaks-zero-quantity-line/) | fulfillmentCreate errors when a multi line order intentionally leaves one line unfulfilled, blocking partial shipment. Script identifies orders stuck mid fulfillment. | Diagnostic | [Read](https://www.allanninal.dev/saleor/partial-fulfillment-breaks-zero-quantity-line/) |
| [editing-order-reverts-to-draft](./editing-order-reverts-to-draft/) | Changing shipping address or lines on a placed order flips order status back to DRAFT, hiding it from normal queues. Script scans for draft orders that already have payments attached. | Diagnostic | [Read](https://www.allanninal.dev/saleor/editing-order-reverts-to-draft/) |
| [draft-order-complete-drops-voucher](./draft-order-complete-drops-voucher/) | Converting a draft order with a voucher loses the discount on completion, understating the applied discount. Script compares draft versus completed order discount and totals. | Diagnostic | [Read](https://www.allanninal.dev/saleor/draft-order-complete-drops-voucher/) |
| [draft-order-taxes-reset-on-completion](./draft-order-taxes-reset-on-completion/) | Tax fields computed on the draft order get wiped once draftOrderComplete runs, leaving blank tax on the final order. Script compares pre and post completion tax fields. | Diagnostic | [Read](https://www.allanninal.dev/saleor/draft-order-taxes-reset-on-completion/) |
| [manual-line-discount-deleted-on-recalculation](./manual-line-discount-deleted-on-recalculation/) | Manually applied line level discounts vanish after certain order update mutations trigger a recalculation. Script compares line discounts before and after updates. | Diagnostic | [Read](https://www.allanninal.dev/saleor/manual-line-discount-deleted-on-recalculation/) |
| [gift-card-order-blocks-unfulfill-delete](./gift-card-order-blocks-unfulfill-delete/) | Orders partly paid with a gift card get stuck because unfulfill or delete mutations error out. Script detects gift card orders that fail lifecycle mutations. | Diagnostic | [Read](https://www.allanninal.dev/saleor/gift-card-order-blocks-unfulfill-delete/) |
| [captured-amount-doubles-order-total](./captured-amount-doubles-order-total/) | Two capture transactions each equal to the total get recorded, leaving totalCaptured at twice the order total. Script sums transaction events per order and flags totals exceeding the order total. | Diagnostic | [Read](https://www.allanninal.dev/saleor/captured-amount-doubles-order-total/) |
| [order-charged-more-than-total](./order-charged-more-than-total/) | A bad payment or transaction amount lets captured plus authorized exceed the order total unchecked. Script flags any order where captured plus authorized exceeds total. | Diagnostic | [Read](https://www.allanninal.dev/saleor/order-charged-more-than-total/) |
| [total-balance-drift-after-refund](./total-balance-drift-after-refund/) | totalBalance is not recalculated correctly after authorization adjustment or refund success events. Script recomputes balance from transactions and flags mismatched orders. | Diagnostic | [Read](https://www.allanninal.dev/saleor/total-balance-drift-after-refund/) |
| [no-available-payment-gateways](./no-available-payment-gateways/) | A payment plugin is enabled in the dashboard but checkout reports zero gateways for the channel. Script queries available payment gateways per channel to detect config gaps. | Diagnostic | [Read](https://www.allanninal.dev/saleor/no-available-payment-gateways/) |
| [charged-amount-stale-after-manual-capture](./charged-amount-stale-after-manual-capture/) | totalCharged does not update after a manual capture unless a transaction event report or update call is made. Script reconciles gateway captures against Saleor transaction records. | Reconciler | [Read](https://www.allanninal.dev/saleor/charged-amount-stale-after-manual-capture/) |
| [voucher-usage-double-incremented](./voucher-usage-double-incremented/) | Two stage payment flows call checkoutComplete twice, double incrementing voucher used count. Script recomputes real usage from orders and corrects the counter. | Reconciler | [Read](https://www.allanninal.dev/saleor/voucher-usage-double-incremented/) |
| [voucher-usable-past-usage-limit](./voucher-usable-past-usage-limit/) | A race condition lets a single use voucher be redeemed by two simultaneous completing checkouts. Script counts actual redemptions against usage limit to find overages. | Reconciler | [Read](https://www.allanninal.dev/saleor/voucher-usable-past-usage-limit/) |
| [entire-order-percentage-voucher-miscalculated](./entire-order-percentage-voucher-miscalculated/) | Percentage vouchers on the entire order compute a discount inconsistent with the stated percentage or base amount. Script recomputes expected discount and flags mismatched orders. | Diagnostic | [Read](https://www.allanninal.dev/saleor/entire-order-percentage-voucher-miscalculated/) |
| [gift-card-balance-update-overwrites-initial](./gift-card-balance-update-overwrites-initial/) | Updating balanceAmount resets both current and initial balance even on an already used card. Script detects cards where current balance exceeds initial balance. | Diagnostic | [Read](https://www.allanninal.dev/saleor/gift-card-balance-update-overwrites-initial/) |
| [gift-card-balance-not-restored-on-cancel](./gift-card-balance-not-restored-on-cancel/) | Cancelling a paid order does not refund the gift card balance that was used. Script finds cancelled orders with gift card payments and restores the balance. | Repair | [Read](https://www.allanninal.dev/saleor/gift-card-balance-not-restored-on-cancel/) |
| [webhook-deliveries-stuck-failed](./webhook-deliveries-stuck-failed/) | Async webhooks stop retrying after five exponential backoff attempts and sit as failed. Script queries event delivery status and retries stale failed ones. | Repair | [Read](https://www.allanninal.dev/saleor/webhook-deliveries-stuck-failed/) |
| [queued-events-fail-while-app-disabled](./queued-events-fail-while-app-disabled/) | Disabling an app drops queued events as permanently failed instead of delivering them on reactivation. Script diffs expected versus delivered events after re-enabling an app. | Reconciler | [Read](https://www.allanninal.dev/saleor/queued-events-fail-while-app-disabled/) |
| [webhook-payload-diverges-from-schema](./webhook-payload-diverges-from-schema/) | Delivered webhook payloads do not match the documented schema for that event type. Script diffs sample payloads against the expected schema to flag drift. | Diagnostic | [Read](https://www.allanninal.dev/saleor/webhook-payload-diverges-from-schema/) |
| [order-updated-webhook-skipped-on-metadata-change](./order-updated-webhook-skipped-on-metadata-change/) | Updating an order's metadata or private metadata does not trigger the ORDER_UPDATED async event. Script compares metadata update timestamps to webhook delivery logs. | Diagnostic | [Read](https://www.allanninal.dev/saleor/order-updated-webhook-skipped-on-metadata-change/) |
| [tax-calculation-rounding-mismatch](./tax-calculation-rounding-mismatch/) | Flat rate tax calculation produces amounts off by cents from the expected rate, skewing order totals. Script recalculates expected tax and flags line or order mismatches. | Diagnostic | [Read](https://www.allanninal.dev/saleor/tax-calculation-rounding-mismatch/) |
| [order-subtotal-gross-instead-of-net](./order-subtotal-gross-instead-of-net/) | Order subtotal is computed from gross rather than net line prices when tax is included, producing an incorrect figure. Script recomputes subtotal from net prices and compares to the stored value. | Diagnostic | [Read](https://www.allanninal.dev/saleor/order-subtotal-gross-instead-of-net/) |
| [discount-rounding-change-breaks-totals-after-upgrade](./discount-rounding-change-breaks-totals-after-upgrade/) | The 3.11 to 3.12 rounding mode change alters checkout and order totals for percentage vouchers post upgrade. Script recomputes discounted totals to find pre and post upgrade drift. | Reconciler | [Read](https://www.allanninal.dev/saleor/discount-rounding-change-breaks-totals-after-upgrade/) |
| [invalid-index-after-failed-migration](./invalid-index-after-failed-migration/) | A failed CREATE INDEX CONCURRENTLY during a version upgrade leaves an invalid index in Postgres. Script queries pg_index for indisvalid false and rebuilds them. | Diagnostic | [Read](https://www.allanninal.dev/saleor/invalid-index-after-failed-migration/) |
| [bulk-imported-variants-missing-channel-listings](./bulk-imported-variants-missing-channel-listings/) | Bulk variant or product creation can leave variants without required channel listing entries, making the imported catalog unsellable. Script diffs imported variant IDs against the channel listing table. | Reconciler | [Read](https://www.allanninal.dev/saleor/bulk-imported-variants-missing-channel-listings/) |
| [confirmation-email-sent-before-payment](./confirmation-email-sent-before-payment/) | Confirmation email fires on order creation ahead of payment success, misleading customers on unpaid orders. Script flags orders where the confirmation event predates the first charge success. | Diagnostic | [Read](https://www.allanninal.dev/saleor/confirmation-email-sent-before-payment/) |
| [guest-order-not-linked-to-customer](./guest-order-not-linked-to-customer/) | Guest checkouts with an email matching a registered user do not attach the order to that user, undercounting customer orders. Script matches order email to user records and flags unlinked orders. | Diagnostic | [Read](https://www.allanninal.dev/saleor/guest-order-not-linked-to-customer/) |
| [duplicate-customer-address-rows](./duplicate-customer-address-rows/) | Every order with shipping creates a new address row even when it matches a saved address, bloating the address book. Script finds and merges duplicate addresses per user. | Reconciler | [Read](https://www.allanninal.dev/saleor/duplicate-customer-address-rows/) |

More fixes land as the guides are published. Watch or star the repo to follow along.

## Running the tests

The decision logic in every fix is a pure function with no network calls, so the tests run anywhere.

```bash
# Python
pip install pytest
pytest

# Node
node --test
```

## A note on safety

These scripts can change orders, inventory, prices, and issue refunds. Always run with `DRY_RUN=true` first, read the output, and confirm it is correct before you let a script write. Test against a staging store when you can.

## Work with me

Fighting a Saleor bug you would rather hand off? That is what I do.

- GitHub: [github.com/allanninal](https://github.com/allanninal)
- LinkedIn: [in/allanninal](https://www.linkedin.com/in/allanninal/)
- Support the work: [ko-fi.com/allanninal](https://ko-fi.com/allanninal)

## License

MIT. Use it, change it, ship it.
