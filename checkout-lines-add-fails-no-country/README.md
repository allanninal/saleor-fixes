# Checkout lines fail to add without a country or pickup

Saleor decides which warehouse to check stock against using the shipping country: `checkout.shippingAddress.country` first, then the channel's `defaultCountry` as a fallback. When a channel has no `defaultCountry` and none of its warehouses have `clickAndCollectOption` enabled, there is no country and no pickup point to resolve a warehouse from. `checkoutCreate` and `checkoutLinesAdd` for an anonymous cart then return a misleading `INSUFFICIENT_STOCK` style error even when stock genuinely exists.

This script lists every channel, flags the ones with no default country and no click and collect enabled warehouse (or a default country that falls outside the channel's own shipping zones with no pickup fallback), and can optionally reproduce the failure live against a real in-stock variant.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/checkout-lines-add-fails-no-country/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"
export FIX_DEFAULT_COUNTRY=""   # e.g. "US", only used when DRY_RUN=false

python checkout-lines-add-fails-no-country/python/flag_checkout_country_risk.py
node   checkout-lines-add-fails-no-country/node/flag-checkout-country-risk.js
```

`classify_checkout_country_risk` / `classifyCheckoutCountryRisk` is a pure decision function: it takes a channel's `defaultCountry`, its warehouses' `clickAndCollectOption`, and the channel's shipping zone countries, and returns whether the channel is at risk and why. It never touches the network. By default the script only reports at risk channels. It only applies a repair with `channelUpdate` when you explicitly set `DRY_RUN=false` and provide `FIX_DEFAULT_COUNTRY`, because choosing the right default country or pickup warehouse is a business decision this script cannot infer safely.

## Test

```bash
pytest checkout-lines-add-fails-no-country/python
node --test checkout-lines-add-fails-no-country/node
```
