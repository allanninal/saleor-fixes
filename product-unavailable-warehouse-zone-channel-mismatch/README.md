# Product unavailable from a warehouse zone channel mismatch

A ProductVariant is only purchasable in a channel when its `Stock.warehouse` is directly assigned to that channel (`Channel.warehouses`), and, only when the store still has `Shop.useLegacyShippingZoneStockAvailability` enabled, when the warehouse's `ShippingZone` is also attached to that channel and covers the customer's destination country. Warehouse-to-channel and warehouse-to-zone-to-channel are separate many-to-many links managed independently, so it is easy to add a warehouse with real stock and forget one of them. `quantityAvailable` then resolves to 0 even though `Stock.quantity` is positive for that variant, and the product silently disappears for customers in that zone or channel (see saleor/saleor#17029).

This script queries the shop's legacy stock flag, one channel's assigned warehouses, and each variant's stocks with their warehouse channels and shipping zones, then runs a pure decision function to report every stock row that is unreachable from the requested channel. It reports by default. It only ever prints a planned repair mutation, gated by `DRY_RUN`, and only after a human confirms the intended zone/channel.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/product-unavailable-warehouse-zone-channel-mismatch/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export SALEOR_CHANNEL_ID="Q2hhbm5lbDox"
export SALEOR_VARIANT_IDS="UHJvZHVjdFZhcmlhbnQ6MQ==,UHJvZHVjdFZhcmlhbnQ6Mg=="
export DRY_RUN="true"

python product-unavailable-warehouse-zone-channel-mismatch/python/find_orphaned_stock.py
node   product-unavailable-warehouse-zone-channel-mismatch/node/find-orphaned-stock.js
```

`find_orphaned_stock` (`findOrphanedStock` in Node) is a pure function: given the fetched variant stock records, a channel graph, the legacy stock mode flag, and an optional destination country, it returns a list of `{variantId, warehouseId, reason}` for every stock row that is unreachable from the channel. `reason` is either `"warehouse not linked to channel"` or, only in legacy mode, `"warehouse zone not linked to channel/destination"`. It does no I/O and is fully deterministic. The script never sends `channelUpdate` or `shippingZoneUpdate` itself, it only reports and, under `DRY_RUN=true`, prints the mutation a human could review and run.

## Test

```bash
pytest product-unavailable-warehouse-zone-channel-mismatch/python
node --test product-unavailable-warehouse-zone-channel-mismatch/node
```
