# Warehouse cannot join a shipping zone without a shared channel

A Saleor `ShippingZone` can only use a warehouse for fulfillment when that warehouse shares at least one channel with the zone. `shippingZoneUpdate(addWarehouses: ...)` enforces this at write time and rejects the field with `INVALID` if the shared channel is missing. But nothing revalidates the link afterward: if a channel is later removed from the warehouse with `channelUpdate`, or removed from the zone with `shippingZoneUpdate`, the warehouse stays listed in the zone's `warehouses` field while sharing zero channels with it, and its stock silently drops out of that zone's fulfillment.

This script queries every shipping zone with its channels and warehouses, and every channel with its warehouses, builds a warehouse-to-channels map (since `Warehouse` has no direct `channels` field), and reports every zone-warehouse pair whose channel intersection is empty.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/warehouse-zone-assignment-needs-shared-channel/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export DRY_RUN="true"

python warehouse-zone-assignment-needs-shared-channel/python/find_orphaned_warehouse_zone_links.py
node   warehouse-zone-assignment-needs-shared-channel/node/find-orphaned-warehouse-zone-links.js
```

Add `--repair` to also detach orphaned pairs with `shippingZoneUpdate(removeWarehouses: ...)`, gated by `DRY_RUN`:

```bash
python warehouse-zone-assignment-needs-shared-channel/python/find_orphaned_warehouse_zone_links.py --repair
node   warehouse-zone-assignment-needs-shared-channel/node/find-orphaned-warehouse-zone-links.js --repair
```

`find_orphaned_warehouse_zone_links` is a pure function: given the fetched shipping zones and a precomputed warehouse-to-channels map, it returns `{zoneId, zoneName, warehouseId, warehouseName, zoneChannelSlugs}` for every pair whose channel intersection is empty. It does no I/O and is fully deterministic. `build_warehouse_channel_map` inverts the channels query's reverse relation (`Channel.warehouses`) into that map. The script never calls `addChannels` or `addWarehouses` on its own, since attaching a new shared channel depends on merchant intent; `--repair` only ever detaches the orphaned pair. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest warehouse-zone-assignment-needs-shared-channel/python
node --test warehouse-zone-assignment-needs-shared-channel/node
```
