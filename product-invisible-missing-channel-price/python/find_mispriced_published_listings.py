"""Flag Saleor products published to a channel with no usable price there.

Publishing a product to a channel (ProductChannelListing.isPublished = true) and
pricing it for that channel (ProductVariantChannelListing.price) are two separate
steps in Saleor. A variant can be published without ever being priced, most often
while onboarding a new channel or bulk importing. The pricing resolvers then return
null and the storefront cannot show or sell the product, while the API still calls
it published. This queries products for a channel with their channel listings and
each variant's channel listings, cross references them by channel slug with a pure
function, and reports every variant that is published without a usable price. It
never invents a price. The only write it can perform, unpublishing the broken
listing, is gated by DRY_RUN and meant to run only after a human has decided
suppressing visibility is the right call.

Guide: https://www.allanninal.dev/saleor/product-invisible-missing-channel-price/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_mispriced_published_listings")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
CHANNEL_SLUG = os.environ.get("SALEOR_CHANNEL_SLUG", "default-channel")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRODUCTS_QUERY = """
query($channel: String!, $cursor: String) {
  products(channel: $channel, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        channelListings { channel { slug } isPublished isAvailableForPurchase
          pricing { priceRange { start { gross { amount currency } } } } }
        variants {
          id
          name
          channelListings { channel { slug } price { amount currency } costPrice { amount } }
        }
      }
    }
  }
}"""

UNPUBLISH_MUTATION = """
mutation($productId: ID!, $channelId: ID!) {
  productChannelListingUpdate(id: $productId, input: {
    updateChannels: [{ channelId: $channelId, isPublished: false }]
  }) {
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


def normalize_product(raw):
    return {
        "id": raw["id"],
        "channelListings": [
            {"channelSlug": cl["channel"]["slug"], "isPublished": cl["isPublished"]}
            for cl in raw.get("channelListings", [])
        ],
        "variants": [
            {
                "id": v["id"],
                "channelListings": [
                    {
                        "channelSlug": cl["channel"]["slug"],
                        "priceAmount": (cl.get("price") or {}).get("amount"),
                    }
                    for cl in v.get("channelListings", [])
                ],
            }
            for v in raw.get("variants", [])
        ],
    }


def find_mispriced_published_listings(products):
    """Pure decision logic. No network or DB calls.

    Takes a list of normalized products, each shaped as:
      {
        "id": str,
        "channelListings": [{"channelSlug": str, "isPublished": bool}, ...],
        "variants": [
          {"id": str, "channelListings": [{"channelSlug": str, "priceAmount": float|None}, ...]},
          ...
        ],
      }

    Returns a list of:
      {"productId": str, "variantId": str, "channelSlug": str, "reason": "missing_price"|"zero_price"}
    """
    flagged = []
    for product in products:
        for listing in product.get("channelListings", []):
            if not listing.get("isPublished"):
                continue
            channel_slug = listing["channelSlug"]
            for variant in product.get("variants", []):
                variant_listing = next(
                    (cl for cl in variant.get("channelListings", [])
                     if cl["channelSlug"] == channel_slug),
                    None,
                )
                if variant_listing is None or variant_listing.get("priceAmount") is None:
                    reason = "missing_price"
                elif variant_listing["priceAmount"] <= 0:
                    reason = "zero_price"
                else:
                    continue
                flagged.append({
                    "productId": product["id"],
                    "variantId": variant["id"],
                    "channelSlug": channel_slug,
                    "reason": reason,
                })
    return flagged


def fetch_products(channel_slug):
    cursor = None
    products = []
    while True:
        data = gql(PRODUCTS_QUERY, {"channel": channel_slug, "cursor": cursor})["products"]
        products.extend(e["node"] for e in data["edges"])
        if not data["pageInfo"]["hasNextPage"]:
            return products
        cursor = data["pageInfo"]["endCursor"]


def unpublish_listing(product_id, channel_id):
    """Only call this after a human has confirmed suppressing visibility is wanted."""
    result = gql(UNPUBLISH_MUTATION, {"productId": product_id, "channelId": channel_id})[
        "productChannelListingUpdate"
    ]
    if result["errors"]:
        raise RuntimeError(result["errors"])


def run():
    raw_products = fetch_products(CHANNEL_SLUG)
    products = [normalize_product(p) for p in raw_products]
    flagged = find_mispriced_published_listings(products)

    if not flagged:
        log.info("Every published listing on channel %s has a usable price.", CHANNEL_SLUG)
        return

    for item in flagged:
        log.warning(
            "Product %s variant %s is published on channel %s with %s.",
            item["productId"], item["variantId"], item["channelSlug"], item["reason"],
        )
        if not DRY_RUN:
            log.info(
                "DRY_RUN is false, but this script only reports by default. "
                "Call unpublish_listing(product_id, channel_id) yourself once a "
                "human has confirmed suppressing visibility is the right call. "
                "The correct fix is productVariantChannelListingUpdate with a real price, "
                "run by a merchandiser."
            )

    log.info("Done. %d variant listing(s) flagged.", len(flagged))


if __name__ == "__main__":
    run()
