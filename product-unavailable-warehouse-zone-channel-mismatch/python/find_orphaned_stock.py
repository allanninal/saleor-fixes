"""Flag Saleor variants whose stock is unreachable from a channel, and why.

A ProductVariant is only purchasable in a channel when its Stock.warehouse is
directly assigned to that channel (Channel.warehouses), and, only when the store
still has Shop.useLegacyShippingZoneStockAvailability enabled, when the warehouse's
ShippingZone is also attached to that channel and covers the customer's destination
country. Because warehouse-to-channel and warehouse-to-zone-to-channel are separate
many-to-many links, it is easy to add a warehouse with real stock and forget one of
them. quantityAvailable then resolves to 0 even though Stock.quantity is positive.

This queries the shop's legacy stock flag, one channel's assigned warehouses, and
each variant's stocks with their warehouse channels and shipping zones, then runs a
pure decision function to report every stock row that is unreachable from the
requested channel. It never mutates merchant topology by default: channelUpdate and
shippingZoneUpdate are only ever printed under DRY_RUN, after a human confirms the
intended zone/channel.

Guide: https://www.allanninal.dev/saleor/product-unavailable-warehouse-zone-channel-mismatch/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_stock")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SHOP_QUERY = """
query { shop { useLegacyShippingZoneStockAvailability } }"""

CHANNEL_QUERY = """
query($id: ID!) {
  channel(id: $id) {
    id slug
    warehouses { id }
  }
}"""

VARIANT_STOCKS_QUERY = """
query($id: ID!, $channel: String!) {
  productVariant(id: $id, channel: $channel) {
    id
    quantityAvailable
    stocks {
      quantity
      warehouse {
        id
        name
        channels { slug }
        shippingZones(first: 100) {
          edges {
            node {
              id
              channels { slug }
              countries { code }
            }
          }
        }
      }
    }
  }
}"""

CHANNEL_UPDATE = """
mutation($id: ID!, $input: ChannelUpdateInput!) {
  channelUpdate(id: $id, input: $input) {
    channel { id warehouses { id } }
    errors { field message }
  }
}"""

SHIPPING_ZONE_UPDATE = """
mutation($id: ID!, $input: ShippingZoneUpdateInput!) {
  shippingZoneUpdate(id: $id, input: $input) {
    shippingZone { id channels { slug } warehouses { id } }
    errors { field message }
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


def find_orphaned_stock(variants, channel, legacy_mode, destination_country=None):
    """Pure decision function. No I/O, fully deterministic.

    variants: list of VariantStockRecord dicts:
        { variantId, warehouseId, quantity, warehouseChannelSlugs: [str],
          warehouseZones: [{ id, channelSlugs: [str], countries: [str] }] }
    channel: { slug, warehouseIds: set-like of str }
    legacy_mode: bool
    destination_country: optional str country code

    Returns a list of {variantId, warehouseId, reason} for every stock row
    that is unreachable from the requested channel (+ optional destination),
    i.e. would report quantityAvailable=0 despite quantity > 0 in the raw
    Stock row.
    """
    issues = []
    for record in variants:
        if record.get("quantity", 0) <= 0:
            continue

        if channel["slug"] not in record.get("warehouseChannelSlugs", []):
            issues.append({
                "variantId": record["variantId"],
                "warehouseId": record["warehouseId"],
                "reason": "warehouse not linked to channel",
            })
            continue

        if legacy_mode:
            matching_zone = next(
                (
                    z for z in record.get("warehouseZones", [])
                    if channel["slug"] in z.get("channelSlugs", [])
                    and (not destination_country or destination_country in z.get("countries", []))
                ),
                None,
            )
            if matching_zone is None:
                issues.append({
                    "variantId": record["variantId"],
                    "warehouseId": record["warehouseId"],
                    "reason": "warehouse zone not linked to channel/destination",
                })

    return issues


def to_variant_stock_records(variant_id, variant_data):
    """Flatten one productVariant GraphQL response into VariantStockRecord rows."""
    records = []
    for stock in variant_data.get("stocks", []):
        warehouse = stock.get("warehouse") or {}
        records.append({
            "variantId": variant_id,
            "warehouseId": warehouse.get("id"),
            "quantity": stock.get("quantity", 0),
            "warehouseChannelSlugs": [c["slug"] for c in warehouse.get("channels", [])],
            "warehouseZones": [
                {
                    "id": edge["node"]["id"],
                    "channelSlugs": [c["slug"] for c in edge["node"].get("channels", [])],
                    "countries": [c["code"] for c in edge["node"].get("countries", [])],
                }
                for edge in (warehouse.get("shippingZones") or {}).get("edges", [])
            ],
        })
    return records


def fetch_legacy_mode():
    return gql(SHOP_QUERY)["shop"]["useLegacyShippingZoneStockAvailability"]


def fetch_channel_graph(channel_id):
    data = gql(CHANNEL_QUERY, {"id": channel_id})["channel"]
    return {
        "slug": data["slug"],
        "warehouseIds": {w["id"] for w in data.get("warehouses", [])},
    }


def fetch_variant_records(variant_id, channel_slug):
    data = gql(VARIANT_STOCKS_QUERY, {"id": variant_id, "channel": channel_slug})["productVariant"]
    if not data:
        return []
    return to_variant_stock_records(variant_id, data)


def print_planned_channel_update(channel_id, warehouse_id):
    variables = {"id": channel_id, "input": {"addWarehouses": [warehouse_id]}}
    log.info("DRY RUN would call channelUpdate: %s", variables)


def print_planned_zone_update(zone_id, warehouse_id, channel_id):
    variables = {"id": zone_id, "input": {"addWarehouses": [warehouse_id], "addChannels": [channel_id]}}
    log.info("DRY RUN would call shippingZoneUpdate: %s", variables)


def run():
    channel_id = os.environ["SALEOR_CHANNEL_ID"]
    variant_ids = [v for v in os.environ.get("SALEOR_VARIANT_IDS", "").split(",") if v]

    legacy_mode = fetch_legacy_mode()
    channel = fetch_channel_graph(channel_id)

    all_records = []
    for variant_id in variant_ids:
        all_records.extend(fetch_variant_records(variant_id, channel["slug"]))

    issues = find_orphaned_stock(all_records, channel, legacy_mode)

    if not issues:
        log.info("No orphaned stock found for channel %s.", channel["slug"])
        return

    for issue in issues:
        log.warning(
            "Variant %s has stock in warehouse %s that is unreachable from channel %s: %s",
            issue["variantId"], issue["warehouseId"], channel["slug"], issue["reason"],
        )
        if DRY_RUN:
            if issue["reason"] == "warehouse not linked to channel":
                print_planned_channel_update(channel_id, issue["warehouseId"])
            else:
                log.info(
                    "Zone repair needs a zone id, which this report does not choose "
                    "automatically. Review the warehouse's shippingZones and pick the "
                    "correct one before calling shippingZoneUpdate."
                )

    log.info("Done. %d orphaned stock row(s) flagged.", len(issues))


if __name__ == "__main__":
    run()
