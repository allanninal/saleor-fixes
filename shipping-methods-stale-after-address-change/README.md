# Shipping methods do not refresh after address change

`checkoutShippingAddressUpdate` invalidates Saleor's shipping method caches (`SHIPPING_LIST_METHODS_FOR_CHECKOUT` and `CHECKOUT_FILTER_SHIPPING_METHODS`) correctly on the server. The stale read is a client problem: a client that fetched `availableShippingMethods` once, at `checkoutCreate` or in the same response as the address mutation, never re-fetches, so the screen keeps showing the pre-update list even though a fresh query would return the right one.

This script re-fetches the checkout fresh after an address or lines mutation, runs a pure decision function against the previously selected method id, the fresh methods list, and the `problems` array, and only ever calls `checkoutDeliveryMethodUpdate` under a `DRY_RUN` guard, logging the `{checkoutId, oldMethodId, newMethodId}` pair before writing anything.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/shipping-methods-stale-after-address-change/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export CHECKOUT_IDS="Q2hlY2tvdXQ6MQ==,Q2hlY2tvdXQ6Mg=="
export DRY_RUN="true"

python shipping-methods-stale-after-address-change/python/reconcile_stale_shipping.py
node   shipping-methods-stale-after-address-change/node/reconcile-stale-shipping.js
```

`decide_stale_shipping` (Python) / `decideStaleShipping` (Node) is a pure function: given the previously selected method id, the fresh `availableShippingMethods` list, and the fresh `problems` array, it returns `{isStale, replacementId}`. It does no I/O and is fully deterministic. `isStale` is true when the old method id is set but missing from the fresh list, or when `problems` contains `CheckoutProblemDeliveryMethodStale` or `CheckoutProblemDeliveryMethodInvalid`. `replacementId` is the first eligible fresh method, or `None`/`null` if the fresh list is empty, or the unchanged old id when nothing is stale. The script never rewrites checkout data on its own: it only reports which checkouts are stale, and only calls `checkoutDeliveryMethodUpdate` once `DRY_RUN` is explicitly set to `false`.

## Test

```bash
pytest shipping-methods-stale-after-address-change/python
node --test shipping-methods-stale-after-address-change/node
```
