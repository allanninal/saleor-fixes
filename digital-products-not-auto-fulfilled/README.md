# Digital products not auto fulfilled despite setting enabled

Saleor's automatic digital fulfillment, whether it comes from the shop-level `automatic_fulfillment_digital_products` flag or a per-`DigitalContent` override, is only ever invoked from `automatically_fulfill_digital_lines()` inside the payment-capture success path, the moment an order becomes fully paid through a real payment or transaction event during checkout completion. An order that reaches paid a different way, through `orderMarkAsPaid`, a draft order completion, a manual transaction adjustment, or a webhook outside the normal fully-paid signal, never runs that function, so its digital-only lines stay Unfulfilled even though the setting is correctly enabled. A digital variant with no warehouse `Stock` row is skipped the same way, since the routine still needs a stock row to build a `FulfillmentLine`.

This script lists unfulfilled orders, works out how each one became paid, and reports the ones that are fully paid through the real payment path, entirely digital, and backed by stock on every line, which is exactly the set the automatic hook would have handled if it had ever run. With `DRY_RUN` off it can optionally call `orderFulfill` for those confirmed-safe orders.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/digital-products-not-auto-fulfilled/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export SHOP_AUTOMATIC_FULFILLMENT_DIGITAL="true"
export SALEOR_WAREHOUSE_ID="warehouse id used to build the fulfillment lines"
export DRY_RUN="true"

python digital-products-not-auto-fulfilled/python/flag_unfulfilled_digital_orders.py
node   digital-products-not-auto-fulfilled/node/flag-unfulfilled-digital-orders.js
```

`should_auto_fulfill` is a pure function: an order is treated as safe to auto-fulfill only when it is paid, still unfulfilled or partially fulfilled, paid through `CHECKOUT_CAPTURE` or `TRANSACTION_ACTION` rather than a manual mark, every line is non-shipping and backed by stock, and the effective automatic fulfillment flag for every line (the per-content override when `use_default_settings` is False, otherwise the shop default) is true. It never marks anything paid and never touches an order missing any of those. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest digital-products-not-auto-fulfilled/python
node --test digital-products-not-auto-fulfilled/node
```
