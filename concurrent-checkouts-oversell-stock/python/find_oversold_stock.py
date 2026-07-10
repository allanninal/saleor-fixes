"""Find Saleor variant and warehouse pairs where quantityAllocated exceeds quantity.

Concurrent checkouts can race through Saleor's check-then-allocate stock flow
(saleor/saleor#543) and both complete, leaving more stock allocated than exists.
This script never rewrites stock or cancels an order. It reports the oversold
pairs, the affected order IDs, and a suggested stockBulkUpdate payload for a
human to review. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_oversold_stock")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
CHANNEL = os.environ.get("SALEOR_CHANNEL", "default-channel")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VARIANTS_QUERY = """
query($channel: String!, $cursor: String) {
  productVariants(channel: $channel, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        stocks { warehouse { id slug } quantity quantityAllocated }
      }
    }
  }
}"""

ORDERS_WITH_ALLOCATIONS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor,
         filter: { status: [UNFULFILLED, PARTIALLY_FULFILLED] }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        lines {
          variant { id sku }
          allocations { quantity warehouse { id } }
        }
      }
    }
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


def find_oversold_stocks(stocks):
    """Pure decision logic. Takes an already-fetched stock snapshot array and
    returns the oversold subset, sorted by delta descending, for the caller
    to report. No I/O.
    """
    oversold = []
    for stock in stocks:
        delta = stock["quantityAllocated"] - stock["quantity"]
        if delta > 0:
            oversold.append({
                "variantId": stock["variantId"],
                "sku": stock["sku"],
                "warehouseId": stock["warehouseId"],
                "delta": delta,
            })
    oversold.sort(key=lambda row: row["delta"], reverse=True)
    return oversold


def stock_snapshot(channel):
    cursor = None
    rows = []
    while True:
        data = gql(VARIANTS_QUERY, {"channel": channel, "cursor": cursor})["productVariants"]
        for edge in data["edges"]:
            node = edge["node"]
            for stock in node["stocks"]:
                rows.append({
                    "variantId": node["id"],
                    "sku": node["sku"],
                    "warehouseId": stock["warehouse"]["id"],
                    "warehouseSlug": stock["warehouse"]["slug"],
                    "quantity": stock["quantity"],
                    "quantityAllocated": stock["quantityAllocated"],
                })
        if not data["pageInfo"]["hasNextPage"]:
            return rows
        cursor = data["pageInfo"]["endCursor"]


def orders_allocating_variant(variant_id, warehouse_id):
    cursor = None
    matches = []
    while True:
        data = gql(ORDERS_WITH_ALLOCATIONS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            order = edge["node"]
            for line in order["lines"]:
                if not line["variant"] or line["variant"]["id"] != variant_id:
                    continue
                for allocation in line["allocations"]:
                    if allocation["warehouse"]["id"] == warehouse_id:
                        matches.append(order["id"])
        if not data["pageInfo"]["hasNextPage"]:
            return matches
        cursor = data["pageInfo"]["endCursor"]


def run():
    stocks = stock_snapshot(CHANNEL)
    oversold = find_oversold_stocks(stocks)
    if not oversold:
        log.info("Done. No oversold variant and warehouse pairs found.")
        return

    for row in oversold:
        affected_orders = orders_allocating_variant(row["variantId"], row["warehouseId"])
        log.warning(
            "OVERSOLD sku=%s variant=%s warehouse=%s delta=%d affected_orders=%s",
            row["sku"], row["variantId"], row["warehouseId"], row["delta"], affected_orders,
        )
        suggested_payload = {
            "stocks": [{
                "variantId": row["variantId"],
                "warehouseId": row["warehouseId"],
                "quantity": "<corrected on-hand count from a physical recount>",
            }],
            "errorPolicy": "REJECT_EVERYTHING",
        }
        log.info(
            "Suggested repair (%s, not applied automatically): %s",
            "dry run" if DRY_RUN else "human review required",
            suggested_payload,
        )
    log.info("Done. %d oversold variant and warehouse pair(s) reported.", len(oversold))


if __name__ == "__main__":
    run()
