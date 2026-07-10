# Variant has no channel listing after creation

A variant made through `productVariantCreate`, `productVariantBulkCreate`, or a CSV import only creates the `ProductVariant` row. It becomes sellable on a channel only once a separate `ProductVariantChannelListing` row exists for that channel with a price, and plenty of scripts and importers skip that step. Because `ProductChannelListing` (product publication) and `ProductVariantChannelListing` (variant price per channel) are tracked independently, a product can look published while a variant has zero channel listings and is unsellable.

This job pages through variants on a channel, compares the channels the product is published on against the channels the variant actually has a listing for, and reports the gap. It only writes a repair, through `productVariantChannelListingUpdate`, when a safe price is available from a sibling variant on the same product and channel or a configured default. Otherwise it skips the write and flags the variant for manual pricing.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/variant-missing-channel-listing/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export SALEOR_CHANNEL="default-channel"
export DRY_RUN="true"

python variant-missing-channel-listing/python/fix_missing_channel_listing.py
node   variant-missing-channel-listing/node/fix-missing-channel-listing.js
```

`find_variants_missing_channel_listing` is a pure function: given plain variant rows with `productChannelSlugs` and `variantChannelSlugs`, it returns only the variants missing at least one channel listing, along with which channels are missing. `resolve_price` / `resolvePrice` is also pure: it prefers a sibling variant's price on the same product and channel, then falls back to a configured default, and returns nothing when neither exists so the caller knows to skip the write. Start with `DRY_RUN=true` to review the report first; repairs only run for channels where a safe price was found.

## Test

```bash
pytest variant-missing-channel-listing/python
node --test variant-missing-channel-listing/node
```
