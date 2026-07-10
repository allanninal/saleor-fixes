# Bulk imported variants missing channel listings

Creating a variant with `productVariantCreate` or `productVariantBulkCreate` does not automatically make it sellable in any channel. Channel listings, price, cost price, and publication, live in a separate `ProductVariantChannelListing` row that must be set explicitly, either via the `channelListings` input on bulk create or a follow-up `productVariantChannelListingUpdate` call. Import scripts that only send `sku`, attributes, and stocks, or that partially fail mid-batch, can leave a variant with zero listing rows, so it never shows a price and never appears in checkout even though the product looks published.

This reconciler pages through a product's variants and channel listings, diffs each variant against the channels the product is actually listed in, and only fills a gap when a real price is available, never guessing a number.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/bulk-imported-variants-missing-channel-listings/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export PRODUCT_ID="gid://saleor/Product/1"
export DRY_RUN="true"

python bulk-imported-variants-missing-channel-listings/python/find_missing_listings.py
node   bulk-imported-variants-missing-channel-listings/node/find-missing-listings.js
```

`find_missing_channel_listings` is a pure function: it takes the imported variant ids, a map of each variant's current channel listing slugs, and the full list of channel slugs the product is listed in, and returns `{variant_id: [missing_slugs]}` only for variants with a gap. The script only reports by default. With `DRY_RUN=false` it fills a gap only when a price is supplied through a price map keyed by variant and channel, and skips (with a log line) any gap it cannot price. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest bulk-imported-variants-missing-channel-listings/python
node --test bulk-imported-variants-missing-channel-listings/node
```
