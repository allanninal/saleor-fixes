"""Flag Saleor SKUs that were double sold because duplicate, non-atomic stock
checks at checkoutCreate, checkoutLinesAdd, checkoutShippingAddressUpdate, and
checkoutComplete let two concurrent checkouts both pass.

Report only. Never edits stock or cancels an order. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/duplicate-stock-checks-allow-oversell/
"""
import os
import datetime
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_oversold")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
ORDER_WINDOW_DAYS = float(os.environ.get("ORDER_WINDOW_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CANCELLED_STATUSES = {"CANCELED", "CANCELLED"}

ORDERS_QUERY = """
query($cursor: String, $createdGte: DateTime!) {
  orders(first: 100, after: $cursor, filter: { created: { gte: $createdGte } }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        lines {
          id
          productVariant { id sku }
          quantity
          quantityFulfilled
          allocations { id quantity warehouse { id name } }
        }
      }
    }
  }
}"""

WAREHOUSES_QUERY = """
query($cursor: String) {
  warehouses(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        stocks {
          id
          quantity
          quantityAllocated
          productVariant { id sku }
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


def find_oversold_lines(orders, stocks):
    """
    Pure decision logic, no I/O.
    orders: [{"order_id": str, "status": str, "lines": [{"sku": str, "warehouse_id": str, "allocated_qty": int}]}]
    stocks: [{"sku": str, "warehouse_id": str, "on_hand_qty": int, "reported_allocated_qty": int}]
    Returns one dict per (sku, warehouse_id) pair where recomputed demand exceeds physical stock:
    [{"sku": str, "warehouse_id": str, "on_hand_qty": int, "recomputed_allocated_qty": int,
      "reported_allocated_qty": int, "oversold_by": int, "offending_order_ids": [str]}]
    """
    recomputed = {}
    offenders = {}
    for order in orders:
        if (order.get("status") or "").upper() in CANCELLED_STATUSES:
            continue
        for line in order.get("lines", []):
            key = (line["sku"], line["warehouse_id"])
            recomputed[key] = recomputed.get(key, 0) + line["allocated_qty"]
            offenders.setdefault(key, set()).add(order["order_id"])

    results = []
    for stock in stocks:
        key = (stock["sku"], stock["warehouse_id"])
        recomputed_qty = recomputed.get(key, 0)
        on_hand = stock["on_hand_qty"]
        reported = stock["reported_allocated_qty"]
        oversold_by_stock = recomputed_qty - on_hand
        mismatched = recomputed_qty != reported
        if oversold_by_stock > 0 or mismatched:
            results.append({
                "sku": stock["sku"],
                "warehouse_id": stock["warehouse_id"],
                "on_hand_qty": on_hand,
                "recomputed_allocated_qty": recomputed_qty,
                "reported_allocated_qty": reported,
                "oversold_by": max(oversold_by_stock, 0),
                "offending_order_ids": sorted(offenders.get(key, set())),
            })
    return results


def recent_orders(created_gte_iso):
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor, "createdGte": created_gte_iso})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def all_warehouse_stocks():
    cursor = None
    while True:
        data = gql(WAREHOUSES_QUERY, {"cursor": cursor})["warehouses"]
        for edge in data["edges"]:
            warehouse = edge["node"]
            for stock in warehouse["stocks"]:
                yield warehouse["id"], warehouse["name"], stock
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def _flatten_orders():
    created_gte = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=ORDER_WINDOW_DAYS)
    ).strftime("%Y-%m-%dT%H:%M:%S%z")
    flat = []
    for order in recent_orders(created_gte):
        lines = []
        for line in order["lines"]:
            sku = (line.get("productVariant") or {}).get("sku")
            if not sku:
                continue
            for allocation in line.get("allocations") or []:
                lines.append({
                    "sku": sku,
                    "warehouse_id": allocation["warehouse"]["id"],
                    "allocated_qty": allocation["quantity"],
                })
        flat.append({"order_id": order["id"], "status": order["status"], "lines": lines})
    return flat


def _flatten_stocks():
    flat = []
    for warehouse_id, _name, stock in all_warehouse_stocks():
        sku = (stock.get("productVariant") or {}).get("sku")
        if not sku:
            continue
        flat.append({
            "sku": sku,
            "warehouse_id": warehouse_id,
            "on_hand_qty": stock["quantity"],
            "reported_allocated_qty": stock["quantityAllocated"],
        })
    return flat


def run():
    mode = "dry run" if DRY_RUN else "live"
    log.info("Scanning orders from the last %.0f day(s) (%s, report only)", ORDER_WINDOW_DAYS, mode)
    orders = _flatten_orders()
    stocks = _flatten_stocks()
    oversold = find_oversold_lines(orders, stocks)
    for row in oversold:
        log.warning(
            "OVERSOLD sku=%s warehouse=%s on_hand=%d recomputed_allocated=%d reported_allocated=%d oversold_by=%d orders=%s",
            row["sku"], row["warehouse_id"], row["on_hand_qty"], row["recomputed_allocated_qty"],
            row["reported_allocated_qty"], row["oversold_by"], ",".join(row["offending_order_ids"]),
        )
    log.info("Done. %d SKU/warehouse pair(s) flagged. No stock or orders were changed.", len(oversold))
    return oversold


if __name__ == "__main__":
    run()
