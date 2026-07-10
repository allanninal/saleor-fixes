# Variant pricing query returns null without a channel argument

`ProductVariant.pricing` and `Product.pricing` resolve per channel, against the matching `ProductVariantChannelListing`. Omit the `channel` argument on `productVariants`, or on a parent `product`/`products` query, and Saleor has no channel context to resolve against, so `pricing` comes back null for every row, even for variants that are correctly priced in one or more channels. This script runs a naive channel-less pass to show the contrast, then re-queries `productVariants` once per active channel with `channel` set, reads `channelListings` directly, and classifies each variant with a pure decision function so only genuinely unpriced variants get reported.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/variant-pricing-null-without-channel-arg/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"

python variant-pricing-null-without-channel-arg/python/flag_variant_pricing_gaps.py
node   variant-pricing-null-without-channel-arg/node/flag-variant-pricing-gaps.js
```

`classify_variant_pricing` is a pure function: it filters a variant's channel listings down to the active channels, and returns `NOT_SOLD_IN_ACTIVE_CHANNEL` when none remain, `UNPRICED_NULL_PRICE` when an active listing has no price, `UNPRICED_MISSING_LISTING` when a published channel has no listing row at all, and `PRICED` otherwise. This is a detection script, not an auto-repair one, because the correct price is a business decision Saleor cannot derive on its own. Under `DRY_RUN=true` (the default) it only logs the flagged `{variantId, sku, channelSlug, reason}` rows. When `DRY_RUN=false` and a human-supplied price map is passed to `run()`, it calls `productVariantChannelListingUpdate` to backfill only the approved price for that variant and channel. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest variant-pricing-null-without-channel-arg/python
node --test variant-pricing-null-without-channel-arg/node
```
