# Product published but invisible from a missing channel price

Publishing a product to a channel (`ProductChannelListing.isPublished = true`) and pricing it for that channel (`ProductVariantChannelListing.price`) are two separate steps in Saleor. A variant can be assigned and published to a channel without ever being priced there, which happens easily when onboarding a new channel or bulk importing. Saleor's `pricing` resolvers return null when no price row exists for the channel, so the API silently reports the product as published while the storefront cannot show or sell it.

This script queries every product for a channel with its channel listings and each variant's channel listings, cross references them by channel slug with a pure function, and flags every variant that is published without a usable price. It reports by default. Setting the correct price is left to a merchandiser using `productVariantChannelListingUpdate`. The only optional write, unpublishing the broken listing with `productChannelListingUpdate`, only happens when `DRY_RUN=false` and a human has confirmed it in the calling code.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/product-invisible-missing-channel-price/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export SALEOR_CHANNEL_SLUG="default-channel"
export DRY_RUN="true"

python product-invisible-missing-channel-price/python/find_mispriced_published_listings.py
node   product-invisible-missing-channel-price/node/find-mispriced-published-listings.js
```

`find_mispriced_published_listings` (Python) / `findMispricedPublishedListings` (Node) is a pure function: given normalized products with their channel listings and variant channel listings, it returns a list of `{productId, variantId, channelSlug, reason}` where reason is `missing_price` or `zero_price`. It does no I/O and is fully deterministic. The script never calls `productVariantChannelListingUpdate` to invent a price. The optional `unpublish_listing` / `unpublishListing` helper is exported but is only ever called by a human after reviewing the flagged list, never automatically.

## Test

```bash
pytest product-invisible-missing-channel-price/python
node --test product-invisible-missing-channel-price/node
```
