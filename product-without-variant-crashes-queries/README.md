# Product without any variant crashes queries

Saleor stores price, SKU, stock, and channel availability on the `ProductVariant`, not the `Product`. A product created through the API without ever calling `productVariantCreate` has zero variants, so `defaultVariant` resolves to null, and pricing or availability resolvers that assume a variant exists can throw or return null in ways storefront and checkout code do not guard against. There is no safe auto-fix, since Saleor cannot invent a SKU, a price, or a stock quantity. This script pages through products, classifies each one as OK, unpublished with no variants, or published with no variants, reports every affected product, and optionally unpublishes the published ones per channel.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/product-without-variant-crashes-queries/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export SALEOR_CHANNEL_SLUG="default-channel"
export DRY_RUN="true"

python product-without-variant-crashes-queries/python/flag_variantless_products.py
node   product-without-variant-crashes-queries/node/flag-variantless-products.js
```

`classify_variant_health` is a pure function: a product is `OK` when it has at least one variant. Otherwise it computes the channels where the product is still published, returning `NO_VARIANTS_PUBLISHED` when at least one is (the urgent case, since a storefront or checkout query can reach it) or `NO_VARIANTS_UNPUBLISHED` when none are. The only write this script ever makes is an optional `productChannelListingUpdate` that unpublishes a `NO_VARIANTS_PUBLISHED` product per affected channel, and only when `DRY_RUN` is off. It never invents a variant, a SKU, or a price. `DRY_RUN` defaults to `true`.

## Test

```bash
pytest product-without-variant-crashes-queries/python
node --test product-without-variant-crashes-queries/node
```
