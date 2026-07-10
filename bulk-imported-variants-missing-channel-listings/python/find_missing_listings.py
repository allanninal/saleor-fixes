"""Find Saleor variants that a bulk import left with no channel listing at
all for one or more of the product's channels.

productVariantCreate and productVariantBulkCreate do not automatically make
a variant sellable anywhere. Channel listings, price, cost price, and
publication, live in a separate ProductVariantChannelListing row that must
be set explicitly, either via the channelListings input on bulk create or a
follow-up productVariantChannelListingUpdate call. Import scripts that only
send sku, attributes, and stocks, or that partially fail mid-batch, can
leave a variant with zero listing rows, so it never shows a price and never
appears in checkout even though the product looks published
(saleor/saleor discussion #9731, saleor/saleor#8589).

This script never invents a price. Under DRY_RUN=true (the default) it only
reports the variant and channel gaps. When DRY_RUN=false it fills a gap only
when a price is available from a supplied price map, never guessing.
Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/bulk-imported-variants-missing-channel-listings/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_listings")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRODUCT_QUERY = """
query($id: ID!) {
  product(id: $id) {
    id
    name
    channelListings { channel { id slug } }
    variants {
      id
      sku
      channelListings { channel { slug } price { amount currency } }
    }
  }
}"""

CHANNEL_LISTING_UPDATE = """
mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
  productVariantChannelListingUpdate(id: $id, input: $input) {
    variant { id channelListings { channel { slug } price { amount } } }
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


def find_missing_channel_listings(imported_variant_ids, variant_channel_listings, product_channel_slugs):
    """Pure decision logic, no I/O.

    For each variant_id in imported_variant_ids, look up the channel slugs it
    currently has listings for in variant_channel_listings (a prebuilt map
    from earlier API responses), compute the missing channels as the set
    difference against product_channel_slugs, and return
    {variant_id: sorted(missing)} only for variants where missing is
    non-empty.
    """
    result = {}
    for variant_id in imported_variant_ids:
        have = set(variant_channel_listings.get(variant_id, []))
        missing = set(product_channel_slugs) - have
        if missing:
            result[variant_id] = sorted(missing)
    return result


def product_with_variants(product_id):
    data = gql(PRODUCT_QUERY, {"id": product_id})["product"]
    channel_ids_by_slug = {cl["channel"]["slug"]: cl["channel"]["id"] for cl in data["channelListings"]}
    product_channel_slugs = list(channel_ids_by_slug.keys())
    variant_channel_listings = {
        v["id"]: [cl["channel"]["slug"] for cl in v["channelListings"]]
        for v in data["variants"]
    }
    return product_channel_slugs, channel_ids_by_slug, variant_channel_listings, data["variants"]


def fill_missing_listing(variant_id, channel_id, price):
    result = gql(CHANNEL_LISTING_UPDATE, {
        "id": variant_id,
        "input": [{"channelId": channel_id, "price": price}],
    })["productVariantChannelListingUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["variant"]


def run(product_id, imported_variant_ids=None, price_map=None):
    """price_map keys are (variant_id, channel_slug) tuples mapping to a price.
    Only gaps present in price_map are ever written; everything else is
    reported only, even with DRY_RUN=false.
    """
    price_map = price_map or {}
    product_channel_slugs, channel_ids_by_slug, variant_channel_listings, variants = product_with_variants(product_id)
    variant_ids = imported_variant_ids or [v["id"] for v in variants]

    gaps = find_missing_channel_listings(variant_ids, variant_channel_listings, product_channel_slugs)

    for variant_id, missing_slugs in gaps.items():
        log.warning("Variant %s missing channel listing for: %s", variant_id, ", ".join(missing_slugs))

    if not gaps:
        log.info("Done. No missing channel listings found.")
        return gaps

    if DRY_RUN:
        log.info("Done. %d variant(s) with gaps reported, dry run on.", len(gaps))
        return gaps

    filled = 0
    for variant_id, missing_slugs in gaps.items():
        for slug in missing_slugs:
            price = price_map.get((variant_id, slug))
            if price is None:
                log.warning("No price source for variant %s channel %s, skipping.", variant_id, slug)
                continue
            fill_missing_listing(variant_id, channel_ids_by_slug[slug], price)
            filled += 1
    log.info("Done. %d channel listing(s) filled from a real price source.", filled)
    return gaps


if __name__ == "__main__":
    run(os.environ.get("PRODUCT_ID", ""))
