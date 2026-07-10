"""Find Saleor variant and warehouse pairs where Stock.quantity does not
match reality: either live Allocation rows exceed it, a known physical
count from a WMS export is higher than it, or it is zero while open
allocations exist (saleor/saleor#5578, #4058, #543).

This script never overwrites inventory on its own. Under DRY_RUN=true
(the default) it only reports drifted pairs. When DRY_RUN=false and a
confirmed physical count is supplied per variant and warehouse, it
applies the correction one pair at a time and re-checks quantityAvailable
before moving on. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/stock-quantity-zero-despite-inventory/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_stock_drift")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
CHANNEL = os.environ.get("SALEOR_CHANNEL", "default-channel")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

WAREHOUSES_QUERY = """
query($cursor: String) {
  warehouses(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name slug } }
  }
}"""

VARIANTS_QUERY = """
query($channel: String!, $cursor: String) {
  productVariants(channel: $channel, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        quantityAvailable(countryCode: US)
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

STOCK_BULK_UPDATE = """
mutation($variantId: ID!, $warehouseId: ID!, $quantity: Int!) {
  stockBulkUpdate(stocks: [{ variantId: $variantId, warehouseId: $warehouseId, quantity: $quantity }]) {
    results { stock { id quantity } errors { field message code } }
  }
}"""

VARIANT_AVAILABILITY_QUERY = """
query($id: ID!, $channel: String!) {
  productVariant(id: $id, channel: $channel) { id quantityAvailable(countryCode: US) }
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


def detect_stock_drift(stock, allocations, known_physical_count=None):
    """Pure decision function: no network calls.

    stock: {quantity, quantityAllocated, variantId, warehouseId}
    allocations: [{quantity}, ...]
    known_physical_count: int | None

    Returns {isDrift, delta, reason} where reason is one of
    "allocated_exceeds_quantity", "quantity_below_known_physical_count",
    or "zero_quantity_with_open_allocations".
    """
    allocated_sum = sum(a["quantity"] for a in allocations)
    quantity = stock["quantity"]

    if quantity == 0 and allocated_sum > 0:
        return {"isDrift": True, "delta": allocated_sum, "reason": "zero_quantity_with_open_allocations"}

    if allocated_sum > quantity:
        return {"isDrift": True, "delta": allocated_sum - quantity, "reason": "allocated_exceeds_quantity"}

    if known_physical_count is not None and known_physical_count > quantity:
        return {"isDrift": True, "delta": known_physical_count - quantity, "reason": "quantity_below_known_physical_count"}

    return {"isDrift": False, "delta": 0, "reason": ""}


def all_warehouses():
    cursor = None
    rows = []
    while True:
        data = gql(WAREHOUSES_QUERY, {"cursor": cursor})["warehouses"]
        rows.extend(edge["node"] for edge in data["edges"])
        if not data["pageInfo"]["hasNextPage"]:
            return rows
        cursor = data["pageInfo"]["endCursor"]


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
                    "quantity": stock["quantity"],
                    "quantityAllocated": stock["quantityAllocated"],
                })
        if not data["pageInfo"]["hasNextPage"]:
            return rows
        cursor = data["pageInfo"]["endCursor"]


def allocations_for(variant_id, warehouse_id):
    cursor = None
    matches = []
    while True:
        data = gql(ORDERS_WITH_ALLOCATIONS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            for line in edge["node"]["lines"]:
                if not line["variant"] or line["variant"]["id"] != variant_id:
                    continue
                for allocation in line["allocations"]:
                    if allocation["warehouse"]["id"] == warehouse_id:
                        matches.append({"quantity": allocation["quantity"]})
        if not data["pageInfo"]["hasNextPage"]:
            return matches
        cursor = data["pageInfo"]["endCursor"]


def apply_correction(variant_id, warehouse_id, corrected_quantity):
    result = gql(STOCK_BULK_UPDATE, {
        "variantId": variant_id,
        "warehouseId": warehouse_id,
        "quantity": corrected_quantity,
    })["stockBulkUpdate"]
    for item in result["results"]:
        if item["errors"]:
            raise RuntimeError(item["errors"])
    return result


def confirm_available(variant_id, channel):
    data = gql(VARIANT_AVAILABILITY_QUERY, {"id": variant_id, "channel": channel})["productVariant"]
    return data["quantityAvailable"]


def run(known_physical_counts=None):
    known_physical_counts = known_physical_counts or {}
    stocks = stock_snapshot(CHANNEL)
    flagged = []

    for stock in stocks:
        allocations = allocations_for(stock["variantId"], stock["warehouseId"])
        known = known_physical_counts.get((stock["variantId"], stock["warehouseId"]))
        result = detect_stock_drift(stock, allocations, known)
        if not result["isDrift"]:
            continue
        flagged.append({**stock, **result, "suspectedPhysicalCount": known})
        log.warning(
            "DRIFT sku=%s variant=%s warehouse=%s quantity=%d allocated=%d reason=%s delta=%d",
            stock["sku"], stock["variantId"], stock["warehouseId"],
            stock["quantity"], stock["quantityAllocated"], result["reason"], result["delta"],
        )

    if DRY_RUN:
        log.info("Done (dry run). %d drifted variant and warehouse pair(s) reported.", len(flagged))
        return flagged

    for row in flagged:
        known = row["suspectedPhysicalCount"]
        if known is None:
            log.info("Skipping %s at %s, no confirmed physical count supplied.", row["sku"], row["warehouseId"])
            continue
        apply_correction(row["variantId"], row["warehouseId"], known)
        available = confirm_available(row["variantId"], CHANNEL)
        log.info("Corrected %s at %s to %d. quantityAvailable now %s.", row["sku"], row["warehouseId"], known, available)

    log.info("Done. %d drifted variant and warehouse pair(s) processed.", len(flagged))
    return flagged


if __name__ == "__main__":
    run()
