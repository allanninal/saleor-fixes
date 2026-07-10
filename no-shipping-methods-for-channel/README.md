# No shipping methods available for a channel

A shipping method only becomes usable at checkout in Saleor when three things line up: the shipping zone covers the customer's country, a warehouse in that zone is assigned to the channel, and the method has its own `ShippingMethodChannelListing` for that channel, created with `shippingMethodChannelListingUpdate`. It is easy to build the zone, link it to a channel, and add methods to it while forgetting the separate per-channel listing step. Checkout then returns an empty shipping methods list with no error.

This script queries every channel and shipping zone, cross references them with a pure function, and flags each broken channel with the exact reason: no zone linked, no channel-assigned warehouse, or no listed method. It reports by default. It only ever prints a planned repair mutation, gated by `DRY_RUN`, and only for the unambiguous case where a method's zone is already fully scoped to a single channel and just needs the listing.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/no-shipping-methods-for-channel/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export DRY_RUN="true"

python no-shipping-methods-for-channel/python/find_missing_shipping_coverage.py
node   no-shipping-methods-for-channel/node/find-missing-shipping-coverage.js
```

`find_channels_missing_shipping_coverage` is a pure function: given the fetched channels and shipping zones, it returns a list of `{channelId, reason}` where reason is `NO_ZONE`, `NO_WAREHOUSE_IN_CHANNEL`, or `NO_METHOD_LISTED`. It does no I/O and is fully deterministic. `find_unambiguous_repair` only returns a candidate when a zone is scoped to exactly one channel and one of its methods is missing that channel's listing. The script never sends `shippingZoneUpdate`, `warehouseUpdate`, or `shippingMethodChannelListingUpdate` itself, it only reports and, under `DRY_RUN=true`, prints the mutation a human could review and run.

## Test

```bash
pytest no-shipping-methods-for-channel/python
node --test no-shipping-methods-for-channel/node
```
