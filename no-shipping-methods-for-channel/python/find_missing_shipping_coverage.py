"""Flag Saleor channels that have no usable shipping methods, and why.

A ShippingMethod is only usable at checkout for a channel when the zone covers
the channel, a warehouse in that zone is assigned to the channel, and the method
has its own ShippingMethodChannelListing for that channel. This queries channels
and shipping zones, classifies each channel as NO_ZONE, NO_WAREHOUSE_IN_CHANNEL,
NO_METHOD_LISTED, or not flagged, and reports it. It never writes blindly: a repair
mutation is only ever printed under DRY_RUN, and only for the unambiguous case of a
method whose zone is already fully scoped to one channel and is only missing the
per-channel listing.

Guide: https://www.allanninal.dev/saleor/no-shipping-methods-for-channel/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_shipping_coverage")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CHANNELS_QUERY = """
query { channels { id name slug currencyCode } }"""

ZONES_QUERY = """
query {
  shippingZones(first: 100) {
    edges {
      node {
        id name
        channels { id }
        warehouses { id channels { id } }
        shippingMethods { id name channelListings { channel { id } price { amount } } }
      }
    }
  }
}"""

SHIPPING_METHOD_CHANNEL_LISTING_UPDATE = """
mutation($id: ID!, $input: ShippingMethodChannelListingInput!) {
  shippingMethodChannelListingUpdate(id: $id, input: $input) {
    shippingMethod { id }
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


def find_channels_missing_shipping_coverage(channels, shipping_zones):
    """Pure decision function. Takes plain data structures already fetched
    and returns a list of {channelId, reason} for every channel that has no
    usable shipping method. Does no I/O, deterministic, easy to unit test.
    """
    flagged = []
    for channel in channels:
        cid = channel["id"]
        zones_for_channel = [
            z for z in shipping_zones
            if any(c["id"] == cid for c in z.get("channels", []))
        ]
        if not zones_for_channel:
            flagged.append({"channelId": cid, "reason": "NO_ZONE"})
            continue

        has_warehouse = any(
            any(c["id"] == cid for c in wh.get("channels", []))
            for z in zones_for_channel
            for wh in z.get("warehouses", [])
        )
        if not has_warehouse:
            flagged.append({"channelId": cid, "reason": "NO_WAREHOUSE_IN_CHANNEL"})
            continue

        has_listed_method = any(
            any(cl["channel"]["id"] == cid for cl in m.get("channelListings", []))
            for z in zones_for_channel
            for m in z.get("shippingMethods", [])
        )
        if not has_listed_method:
            flagged.append({"channelId": cid, "reason": "NO_METHOD_LISTED"})

    return flagged


def find_unambiguous_repair(channel, shipping_zones):
    """A repair is unambiguous only when exactly one zone covers the channel,
    that zone has no other channels, and it has at least one shipping method
    with no listing for this channel yet."""
    cid = channel["id"]
    zones_for_channel = [
        z for z in shipping_zones
        if any(c["id"] == cid for c in z.get("channels", []))
    ]
    if len(zones_for_channel) != 1:
        return None
    zone = zones_for_channel[0]
    if len(zone.get("channels", [])) != 1:
        return None
    for method in zone.get("shippingMethods", []):
        if not any(cl["channel"]["id"] == cid for cl in method.get("channelListings", [])):
            return {"shippingMethodId": method["id"], "shippingMethodName": method["name"]}
    return None


def fetch_channels_and_zones():
    channels = gql(CHANNELS_QUERY)["channels"]
    zones = [e["node"] for e in gql(ZONES_QUERY)["shippingZones"]["edges"]]
    return channels, zones


def print_planned_listing_update(shipping_method_id, channel_id, currency):
    variables = {
        "id": shipping_method_id,
        "input": {"addChannels": [{"channelId": channel_id, "price": "0.00", "currency": currency}]},
    }
    log.info("DRY RUN would call shippingMethodChannelListingUpdate: %s", variables)


def run():
    channels, zones = fetch_channels_and_zones()
    flagged = find_channels_missing_shipping_coverage(channels, zones)
    by_id = {c["id"]: c for c in channels}

    if not flagged:
        log.info("Every channel has at least one usable shipping method.")
        return

    for item in flagged:
        channel = by_id[item["channelId"]]
        log.warning("Channel %s (%s) has no usable shipping methods: %s",
                    channel["name"], channel["slug"], item["reason"])
        if item["reason"] == "NO_METHOD_LISTED":
            repair = find_unambiguous_repair(channel, zones)
            if repair:
                log.info("Unambiguous repair candidate: method %s is missing a listing.",
                         repair["shippingMethodName"])
                if DRY_RUN:
                    print_planned_listing_update(
                        repair["shippingMethodId"], channel["id"], channel["currencyCode"]
                    )
                else:
                    log.warning("DRY_RUN is false, but this script only prints planned "
                                "repairs. Review the printed mutation and apply it by hand "
                                "or from your own reviewed tooling.")

    log.info("Done. %d channel(s) flagged.", len(flagged))


if __name__ == "__main__":
    run()
