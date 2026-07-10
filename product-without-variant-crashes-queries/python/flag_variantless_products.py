"""Find Saleor products that have zero variants, report them, and optionally
unpublish the ones that are still published to a channel.

Saleor stores price, SKU, stock, and channel availability on the ProductVariant,
not the Product. A product created without ever calling productVariantCreate
has defaultVariant == null and can crash or silently break pricing and
availability for storefront and checkout code.

There is no safe auto-fix: Saleor cannot invent a SKU, price, or stock quantity.
This is flag and report, with an optional per-channel unpublish gated by DRY_RUN.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/product-without-variant-crashes-queries/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_variantless_products")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
CHANNEL_SLUG = os.environ.get("SALEOR_CHANNEL_SLUG", "default-channel")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRODUCTS_QUERY = """
query($cursor: String, $channel: String) {
  products(first: 100, after: $cursor, channel: $channel) {
    edges {
      node {
        id
        name
        slug
        defaultVariant { id }
        variants { id }
        channelListings { channel { id slug } isPublished }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}"""

UNPUBLISH_MUTATION = """
mutation($productId: ID!, $channelId: ID!) {
  productChannelListingUpdate(id: $productId, input: {
    updateChannels: [{ channelId: $channelId, isPublished: false }]
  }) {
    product { id }
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


def classify_variant_health(product):
    """
    Pure decision logic, no I/O.
    product: {"id": str, "variants": [{"id": str}],
              "channelListings": [{"channel": {"slug": str}, "isPublished": bool}]}
    Returns {"status": "OK" | "NO_VARIANTS_UNPUBLISHED" | "NO_VARIANTS_PUBLISHED",
             "affectedChannels": [str]}
    """
    if len(product.get("variants") or []) > 0:
        return {"status": "OK", "affectedChannels": []}

    affected_channels = [
        cl["channel"]["slug"]
        for cl in (product.get("channelListings") or [])
        if cl.get("isPublished")
    ]
    status = "NO_VARIANTS_PUBLISHED" if affected_channels else "NO_VARIANTS_UNPUBLISHED"
    return {"status": status, "affectedChannels": affected_channels}


def all_products(channel_slug):
    cursor = None
    while True:
        data = gql(PRODUCTS_QUERY, {"cursor": cursor, "channel": channel_slug})["products"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def unpublish_product_channel(product_id, channel_id):
    result = gql(UNPUBLISH_MUTATION, {"productId": product_id, "channelId": channel_id})[
        "productChannelListingUpdate"
    ]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["product"]["id"]


def run():
    mode = "dry run" if DRY_RUN else "live"
    log.info("Scanning products on channel %s (%s)", CHANNEL_SLUG, mode)

    flagged = 0
    unpublished = 0
    for node in all_products(CHANNEL_SLUG):
        result = classify_variant_health(node)
        if result["status"] == "OK":
            continue

        flagged += 1
        log.warning(
            "%s product=%s (%s) affectedChannels=%s",
            result["status"], node["name"], node["slug"], ",".join(result["affectedChannels"]),
        )

        if result["status"] == "NO_VARIANTS_PUBLISHED" and not DRY_RUN:
            channels_by_slug = {
                cl["channel"]["slug"]: cl["channel"]["id"] for cl in node["channelListings"]
            }
            for slug in result["affectedChannels"]:
                channel_id = channels_by_slug.get(slug)
                if channel_id:
                    unpublish_product_channel(node["id"], channel_id)
                    unpublished += 1

    log.info(
        "Done. %d product(s) flagged, %d channel listing(s) %s.",
        flagged, unpublished, "would be unpublished" if DRY_RUN else "unpublished",
    )
    return flagged


if __name__ == "__main__":
    run()
