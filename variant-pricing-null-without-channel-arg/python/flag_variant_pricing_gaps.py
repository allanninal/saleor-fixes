"""Find Saleor product variants that are genuinely missing a price, without
being fooled by a channel-less ProductVariant.pricing query.

ProductVariant.pricing and Product.pricing resolve against a specific
channel's ProductVariantChannelListing. Omit the channel argument and Saleor
has no channel context to resolve against, so pricing comes back null for
every row, priced or not (see the GraphQL null-fields and app pricing
discussions cited in the guide). This script runs a naive channel-less pass
only to show the contrast, then re-queries productVariants once per active
channel with channel set, reads channelListings directly, and classifies
each variant with a pure function.

This is a detection script, not an auto-repair one. Under DRY_RUN=true (the
default) it only reports flagged variants. When DRY_RUN=false and a
human-supplied price map is provided, it calls
productVariantChannelListingUpdate to backfill the approved price. It never
invents a price on its own. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/variant-pricing-null-without-channel-arg/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_variant_pricing_gaps")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

NAIVE_QUERY = """
query($cursor: String) {
  productVariants(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        pricing { price { gross { amount currency } } }
      }
    }
  }
}"""

CHANNELS_QUERY = """
query {
  channels { slug isActive }
}"""

VARIANTS_BY_CHANNEL_QUERY = """
query($cursor: String, $channel: String!) {
  productVariants(first: 50, after: $cursor, channel: $channel) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        channelListings {
          channel { slug }
          isPublished
          price { amount currency }
        }
      }
    }
  }
}"""

CHANNEL_LISTING_UPDATE = """
mutation($id: ID!, $channelId: ID!, $price: PositiveDecimal!) {
  productVariantChannelListingUpdate(
    id: $id,
    input: [{ channelId: $channelId, price: $price }]
  ) {
    variant { id }
    errors { field message code }
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


def classify_variant_pricing(variant, active_channel_slugs):
    """Pure decision function, no I/O.

    Returns one of "PRICED", "UNPRICED_MISSING_LISTING",
    "UNPRICED_NULL_PRICE", "NOT_SOLD_IN_ACTIVE_CHANNEL".
    """
    active = set(active_channel_slugs)
    relevant = [cl for cl in variant.get("channelListings", []) if cl.get("channelSlug") in active]

    if not relevant:
        return "NOT_SOLD_IN_ACTIVE_CHANNEL"

    if any(cl.get("price") is None for cl in relevant):
        return "UNPRICED_NULL_PRICE"

    listed_slugs = {cl.get("channelSlug") for cl in relevant}
    missing_listing = any(
        cl.get("isPublished") and cl.get("channelSlug") not in listed_slugs
        for cl in relevant
    )
    if missing_listing:
        return "UNPRICED_MISSING_LISTING"

    return "PRICED"


def naive_scan_sample(sample_size=5):
    data = gql(NAIVE_QUERY, {"cursor": None})["productVariants"]
    rows = [edge["node"] for edge in data["edges"][:sample_size]]
    for row in rows:
        log.info("naive pass sku=%s pricing=%s (always null here)", row["sku"], row["pricing"])
    return rows


def active_channel_slugs():
    data = gql(CHANNELS_QUERY)["channels"]
    return [c["slug"] for c in data if c["isActive"]]


def variants_for_channel(channel_slug):
    cursor = None
    while True:
        data = gql(VARIANTS_BY_CHANNEL_QUERY, {"cursor": cursor, "channel": channel_slug})["productVariants"]
        for edge in data["edges"]:
            node = edge["node"]
            node["channelListings"] = [
                {
                    "channelSlug": cl["channel"]["slug"],
                    "isPublished": cl["isPublished"],
                    "price": cl["price"],
                }
                for cl in node["channelListings"]
            ]
            yield node
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def backfill_price(variant_id, channel_id, price):
    result = gql(
        CHANNEL_LISTING_UPDATE,
        {"id": variant_id, "channelId": channel_id, "price": price},
    )["productVariantChannelListingUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])


def run(approved_price_map=None):
    """approved_price_map: optional dict of {(variantId, channelSlug): {"channelId": ..., "price": ...}}
    supplied by a human. Nothing is ever backfilled without an explicit entry here
    and DRY_RUN=false.
    """
    approved_price_map = approved_price_map or {}
    naive_scan_sample()

    channels = active_channel_slugs()
    seen = {}
    flagged = []
    for slug in channels:
        for variant in variants_for_channel(slug):
            key = variant["id"]
            if key not in seen:
                seen[key] = variant
        for variant in seen.values():
            verdict = classify_variant_pricing(variant, channels)
            if verdict == "PRICED":
                continue
            entry = {
                "variantId": variant["id"],
                "sku": variant["sku"],
                "channelSlug": slug,
                "reason": verdict,
            }
            flagged.append(entry)
            log.warning(
                "UNPRICED sku=%s channel=%s reason=%s", entry["sku"], entry["channelSlug"], entry["reason"]
            )

    for entry in flagged:
        approved = approved_price_map.get((entry["variantId"], entry["channelSlug"]))
        if not approved:
            continue
        log.info(
            "Variant %s eligible for backfill. %s",
            entry["sku"], "would backfill" if DRY_RUN else "backfilling",
        )
        if not DRY_RUN:
            backfill_price(entry["variantId"], approved["channelId"], approved["price"])

    log.info("Done. %d variant/channel gap(s) found.", len(flagged))
    return flagged


if __name__ == "__main__":
    run()
