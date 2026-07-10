"""Find Saleor variants that have zero ProductVariantChannelListing rows
for a channel their own product is published on (saleor/saleor discussions
#9731, #9422, and issue #8589). productVariantCreate, productVariantBulkCreate,
and CSV importers can all create a variant without attaching a channel price,
leaving it unsellable while the product still looks published.

This script never guesses a price. Under DRY_RUN=true (the default) it only
reports flagged variants and their missing channels. When DRY_RUN=false it
looks for a price from a sibling variant on the same product and channel, or
a configured default, and calls productVariantChannelListingUpdate only when
one of those exists. Channels with no safe price are skipped and reported.
Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_missing_channel_listing")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
CHANNEL = os.environ.get("SALEOR_CHANNEL", "default-channel")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VARIANTS_QUERY = """
query($channel: String, $cursor: String) {
  productVariants(first: 100, after: $cursor, channel: $channel) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        product {
          id
          name
          channelListings { channel { id slug } isPublished }
        }
        channelListings { channel { id slug } price { amount currency } }
      }
    }
  }
}"""

CHANNEL_LISTING_UPDATE = """
mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
  productVariantChannelListingUpdate(id: $id, input: $input) {
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


def find_variants_missing_channel_listing(variants):
    """Pure decision function.

    Takes a list of plain dicts:
      {id, sku, productChannelSlugs: [...], variantChannelSlugs: [...]}
    and returns the subset that are missing at least one channel listing,
    each annotated with missingChannels: [...].
    """
    flagged = []
    for variant in variants:
        product_slugs = variant["productChannelSlugs"]
        variant_slugs = set(variant["variantChannelSlugs"])
        missing = [slug for slug in product_slugs if slug not in variant_slugs]
        if missing:
            flagged.append({"id": variant["id"], "sku": variant["sku"], "missingChannels": missing})
    return flagged


def find_sibling_price(product_id, channel_slug, product_variants_index):
    for sibling in product_variants_index.get(product_id, []):
        for listing in sibling.get("channelListingsRaw", []):
            if listing["channel"]["slug"] == channel_slug and listing.get("price"):
                return listing["price"]["amount"]
    return None


def resolve_price(product_id, channel_slug, product_variants_index, default_prices):
    sibling_price = find_sibling_price(product_id, channel_slug, product_variants_index)
    if sibling_price is not None:
        return sibling_price
    return default_prices.get(channel_slug)


def variant_snapshot(channel):
    cursor = None
    rows = []
    raw_by_product = {}
    channel_ids_by_slug = {}
    while True:
        data = gql(VARIANTS_QUERY, {"channel": channel, "cursor": cursor})["productVariants"]
        for edge in data["edges"]:
            node = edge["node"]
            product_id = node["product"]["id"]
            for cl in node["product"]["channelListings"]:
                channel_ids_by_slug[cl["channel"]["slug"]] = cl["channel"]["id"]
            for cl in node["channelListings"]:
                channel_ids_by_slug[cl["channel"]["slug"]] = cl["channel"]["id"]
            raw_by_product.setdefault(product_id, []).append({
                "sku": node["sku"],
                "channelListingsRaw": node["channelListings"],
            })
            rows.append({
                "id": node["id"],
                "sku": node["sku"],
                "productId": product_id,
                "productChannelSlugs": [
                    cl["channel"]["slug"] for cl in node["product"]["channelListings"] if cl["isPublished"]
                ],
                "variantChannelSlugs": [cl["channel"]["slug"] for cl in node["channelListings"]],
            })
        if not data["pageInfo"]["hasNextPage"]:
            return rows, raw_by_product, channel_ids_by_slug
        cursor = data["pageInfo"]["endCursor"]


def apply_listing(variant_id, channel_id, price, cost_price=None):
    entry = {"channelId": channel_id, "price": price}
    if cost_price is not None:
        entry["costPrice"] = cost_price
    result = gql(CHANNEL_LISTING_UPDATE, {"id": variant_id, "input": [entry]})["productVariantChannelListingUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["variant"]


def run(default_prices=None):
    default_prices = default_prices or {}
    variants, raw_by_product, channel_ids_by_slug = variant_snapshot(CHANNEL)
    flagged = find_variants_missing_channel_listing(variants)
    by_id = {v["id"]: v for v in variants}

    if DRY_RUN:
        for row in flagged:
            log.warning("MISSING sku=%s variant=%s missing_channels=%s", row["sku"], row["id"], row["missingChannels"])
        log.info("Done (dry run). %d variant(s) missing at least one channel listing.", len(flagged))
        return flagged

    repaired = 0
    for row in flagged:
        product_id = by_id[row["id"]]["productId"]
        for slug in row["missingChannels"]:
            price = resolve_price(product_id, slug, raw_by_product, default_prices)
            channel_id = channel_ids_by_slug.get(slug)
            if price is None or channel_id is None:
                log.info("Skipping %s on %s, no safe price found. Flag for manual pricing.", row["sku"], slug)
                continue
            apply_listing(row["id"], channel_id, price)
            log.info("Listed %s on %s at %s.", row["sku"], slug, price)
            repaired += 1

    log.info("Done. %d variant(s) flagged, %d channel listing(s) repaired.", len(flagged), repaired)
    return flagged


if __name__ == "__main__":
    run()
