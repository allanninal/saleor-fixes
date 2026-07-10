"""Find Saleor shipping zones whose warehouses share no channel with the zone.

A ShippingZone can only use a warehouse for fulfillment when that warehouse shares
at least one channel with the zone. shippingZoneUpdate(addWarehouses: ...) enforces
this at write time and rejects the field with INVALID if the shared channel is
missing (see saleor/saleor issue #17029). But nothing revalidates the link later:
if a channel is removed from the warehouse or from the zone afterward, the warehouse
stays listed on the zone with zero shared channels, and its stock silently drops out
of that zone's fulfillment. This queries every shipping zone with its channels and
warehouses, and every channel with its warehouses, builds a warehouse-to-channels
map, and reports every zone-warehouse pair whose channel intersection is empty.
It never writes by default. An optional --repair flag detaches the orphaned pair
with shippingZoneUpdate(removeWarehouses: ...); attaching a new shared channel is
left to a human, since that depends on merchant intent.

Guide: https://www.allanninal.dev/saleor/warehouse-zone-assignment-needs-shared-channel/
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_warehouse_zone_links")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ZONES_AND_CHANNELS_QUERY = """
query {
  shippingZones(first: 100) {
    edges {
      node {
        id name
        channels { id slug }
        warehouses { id name }
      }
    }
  }
  channels(first: 100) {
    edges {
      node {
        id slug
        warehouses(first: 100) { edges { node { id } } }
      }
    }
  }
}"""

REMOVE_WAREHOUSES_MUTATION = """
mutation($id: ID!, $warehouseIds: [ID!]!) {
  shippingZoneUpdate(id: $id, input: { removeWarehouses: $warehouseIds }) {
    shippingZone { id }
    shippingErrors { field message }
  }
}"""


def gql(query, variables=None):
    r = requests.post(
        API_URL,
        json={"query": query, "variables": variables or {}},
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise RuntimeError(body["errors"])
    return body["data"]


def build_warehouse_channel_map(channels):
    """Invert Channel.warehouses into warehouseId -> set(channelSlug).

    Warehouse has no direct channels field in the Saleor schema, so this reverse
    relation from the channels query is the only way to learn which channels a
    warehouse actually belongs to.
    """
    warehouse_channel_map = {}
    for channel in channels:
        slug = channel["slug"]
        for edge in channel.get("warehouses", {}).get("edges", []):
            wid = edge["node"]["id"]
            warehouse_channel_map.setdefault(wid, set()).add(slug)
    return warehouse_channel_map


def find_orphaned_warehouse_zone_links(shipping_zones, warehouse_channel_map):
    """Pure decision function. No I/O.

    For each shipping zone, compute its channel slugs. For each warehouse assigned
    to that zone, look up the warehouse's channel slugs from the precomputed map
    (defaulting to an empty set when the warehouse is missing from the map). If the
    intersection of the two sets is empty, the warehouse cannot actually fulfill
    that zone, so the pair is orphaned and gets reported.
    """
    orphaned = []
    for zone in shipping_zones:
        zone_channel_slugs = {c["slug"] for c in zone.get("channels", [])}
        for warehouse in zone.get("warehouses", []):
            warehouse_channel_slugs = warehouse_channel_map.get(warehouse["id"], set())
            if not (zone_channel_slugs & warehouse_channel_slugs):
                orphaned.append({
                    "zoneId": zone["id"],
                    "zoneName": zone["name"],
                    "warehouseId": warehouse["id"],
                    "warehouseName": warehouse["name"],
                    "zoneChannelSlugs": sorted(zone_channel_slugs),
                })
    return orphaned


def fetch_zones_and_channels():
    data = gql(ZONES_AND_CHANNELS_QUERY)
    zones = [e["node"] for e in data["shippingZones"]["edges"]]
    channels = [e["node"] for e in data["channels"]["edges"]]
    return zones, channels


def detach_warehouse(zone_id, warehouse_id):
    result = gql(REMOVE_WAREHOUSES_MUTATION, {"id": zone_id, "warehouseIds": [warehouse_id]})["shippingZoneUpdate"]
    if result["shippingErrors"]:
        raise RuntimeError(result["shippingErrors"])


def run():
    repair = "--repair" in sys.argv

    zones, channels = fetch_zones_and_channels()
    warehouse_channel_map = build_warehouse_channel_map(channels)
    orphaned = find_orphaned_warehouse_zone_links(zones, warehouse_channel_map)

    if not orphaned:
        log.info("Every zone's warehouses share at least one channel with the zone.")
        return

    for pair in orphaned:
        log.warning(
            "Zone %s has warehouse %s with no shared channel (zone channels: %s)",
            pair["zoneName"], pair["warehouseName"], pair["zoneChannelSlugs"],
        )
        if repair:
            log.info("%s remove warehouse %s from zone %s",
                      "Would" if DRY_RUN else "Will", pair["warehouseName"], pair["zoneName"])
            if not DRY_RUN:
                detach_warehouse(pair["zoneId"], pair["warehouseId"])
        else:
            log.info("Add a shared channel or rerun with --repair to detach. Not modified.")

    log.info("Done. %d orphaned warehouse-zone pair(s) found.", len(orphaned))


if __name__ == "__main__":
    run()
