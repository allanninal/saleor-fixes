"""Find Saleor variant and warehouse pairs whose Stock.quantity changed
without a matching PRODUCT_VARIANT_STOCK_UPDATED webhook delivery.

PRODUCT_VARIANT_STOCK_UPDATED only fires from productVariantStocksUpdate,
stockBulkUpdate, and productVariantStocksCreate/Delete. Quantity changes
from orderFulfill, order cancellation or refund, and draft order completion
mutate Stock directly through allocation helpers that never call
stock_bulk_updated (saleor/saleor#11630, #11637, #6479), so no webhook is
ever created even though the quantity genuinely changed.

This script never re-fires a webhook, Saleor exposes no such mutation.
Under DRY_RUN=true (the default) it only reports desynced pairs. When
DRY_RUN=false it POSTs a synthetic reconciliation payload to your own
external endpoint, shaped like the real webhook payload. Run on a
schedule. Safe to run again and again.
"""
import os
import json
import datetime
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_stock_webhook_desync")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
WEBHOOK_ID = os.environ.get("SALEOR_WEBHOOK_ID", "")
RECONCILE_ENDPOINT = os.environ.get("RECONCILE_ENDPOINT", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CRITICAL_HINTS = {"ORDER_FULFILL", "ORDER_CANCEL"}
CRITICAL_DELTA_RATIO = 0.10

WAREHOUSES_STOCK_QUERY = """
query($cursor: String) {
  warehouses(first: 25, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        stocks(first: 100) {
          edges { node { quantity quantityAllocated productVariant { id sku } } }
        }
      }
    }
  }
}"""

WEBHOOK_DELIVERIES_QUERY = """
query($webhookId: ID!, $after: String) {
  webhook(id: $webhookId) {
    eventDeliveries(first: 100, after: $after,
                     filter: { eventType: PRODUCT_VARIANT_STOCK_UPDATED }) {
      pageInfo { hasNextPage endCursor }
      edges { node { eventType createdAt payload status } }
    }
  }
}"""

RECENT_ORDERS_QUERY = """
query($cursor: String, $since: DateTime) {
  orders(first: 50, after: $cursor,
         filter: { updatedAt: { gte: $since } }) {
    pageInfo { hasNextPage endCursor }
    edges { node { id status fulfillments { id } } }
  }
}"""

STOCK_BULK_UPDATE = """
mutation($variantId: ID!, $warehouseId: ID!, $quantity: Int!) {
  stockBulkUpdate(stocks: [{ variantId: $variantId, warehouseId: $warehouseId, quantity: $quantity }]) {
    results { stock { id quantity } errors { field message code } }
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


def classify_stock_desync(record):
    """Pure decision function. No I/O.

    record: {
      variantId, warehouseId, quantityBefore, quantityAfter,
      matchingDeliveryFound, recentMutationHint, pollWindowMs (optional)
    }
    """
    quantity_before = record["quantityBefore"]
    quantity_after = record["quantityAfter"]

    if quantity_before == quantity_after:
        return {"isDesynced": False, "severity": "none", "reason": "no change"}

    if record.get("matchingDeliveryFound"):
        return {"isDesynced": False, "severity": "none", "reason": "webhook delivered"}

    delta = quantity_after - quantity_before
    hint = record.get("recentMutationHint", "UNKNOWN")
    crosses_zero = (quantity_before == 0) != (quantity_after == 0)
    large_delta = quantity_before != 0 and abs(delta) >= abs(quantity_before) * CRITICAL_DELTA_RATIO

    if hint in CRITICAL_HINTS or large_delta or crosses_zero:
        severity = "critical"
    else:
        severity = "warn"

    reason = f"suspected {hint}, delta {delta:+d} with no matching PRODUCT_VARIANT_STOCK_UPDATED delivery"
    return {"isDesynced": True, "severity": severity, "reason": reason}


def stock_snapshot():
    cursor = None
    rows = {}
    while True:
        data = gql(WAREHOUSES_STOCK_QUERY, {"cursor": cursor})["warehouses"]
        for edge in data["edges"]:
            wh = edge["node"]
            for stock_edge in wh["stocks"]["edges"]:
                stock = stock_edge["node"]
                key = (stock["productVariant"]["id"], wh["id"])
                rows[key] = {
                    "variantId": stock["productVariant"]["id"],
                    "warehouseId": wh["id"],
                    "quantity": stock["quantity"],
                    "quantityAllocated": stock["quantityAllocated"],
                }
        if not data["pageInfo"]["hasNextPage"]:
            return rows
        cursor = data["pageInfo"]["endCursor"]


def diff_snapshots(previous, current):
    deltas = []
    for key, curr in current.items():
        prev = previous.get(key)
        before = prev["quantity"] if prev else curr["quantity"]
        if before != curr["quantity"]:
            deltas.append({
                "variantId": curr["variantId"],
                "warehouseId": curr["warehouseId"],
                "quantityBefore": before,
                "quantityAfter": curr["quantity"],
            })
    return deltas


def deliveries_in_window(webhook_id, window_start_iso, window_end_iso):
    if not webhook_id:
        return []
    cursor = None
    matches = []
    while True:
        data = gql(WEBHOOK_DELIVERIES_QUERY, {"webhookId": webhook_id, "after": cursor})["webhook"]
        edges = data["eventDeliveries"]["edges"]
        for edge in edges:
            node = edge["node"]
            if window_start_iso <= node["createdAt"] <= window_end_iso:
                matches.append(node)
        if not data["eventDeliveries"]["pageInfo"]["hasNextPage"]:
            return matches
        cursor = data["eventDeliveries"]["pageInfo"]["endCursor"]


def has_matching_delivery(deliveries, variant_id, warehouse_id):
    for delivery in deliveries:
        try:
            payload = json.loads(delivery["payload"])
        except (TypeError, ValueError):
            continue
        if payload.get("productVariant", {}).get("id") == variant_id and \
           payload.get("warehouse", {}).get("id") == warehouse_id:
            return True
    return False


def recent_mutation_hint(since_iso):
    try:
        data = gql(RECENT_ORDERS_QUERY, {"cursor": None, "since": since_iso})["orders"]
    except Exception:
        return "UNKNOWN"
    for edge in data["edges"]:
        node = edge["node"]
        if node["status"] == "CANCELED":
            return "ORDER_CANCEL"
        if node["fulfillments"]:
            return "ORDER_FULFILL"
    return "UNKNOWN"


def reconcile_external(record):
    if not RECONCILE_ENDPOINT:
        log.info("No RECONCILE_ENDPOINT configured, skipping external POST.")
        return
    payload = {
        "productVariant": {"id": record["variantId"]},
        "warehouse": {"id": record["warehouseId"]},
        "quantity": record["quantityAfter"],
        "quantityAllocated": record.get("quantityAllocated"),
    }
    if DRY_RUN:
        log.info("Would POST reconciliation payload: %s", payload)
        return
    r = requests.post(RECONCILE_ENDPOINT, json=payload, timeout=30)
    r.raise_for_status()


def run(previous_snapshot=None):
    previous_snapshot = previous_snapshot or {}
    current_snapshot = stock_snapshot()
    deltas = diff_snapshots(previous_snapshot, current_snapshot)

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    window_start_iso = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).isoformat()
    deliveries = deliveries_in_window(WEBHOOK_ID, window_start_iso, now_iso)
    hint = recent_mutation_hint(window_start_iso)

    flagged = []
    for delta in deltas:
        found = has_matching_delivery(deliveries, delta["variantId"], delta["warehouseId"])
        record = {**delta, "matchingDeliveryFound": found, "recentMutationHint": hint}
        result = classify_stock_desync(record)
        if not result["isDesynced"]:
            continue
        flagged.append({**record, **result})
        log.warning(
            "DESYNC severity=%s variant=%s warehouse=%s before=%d after=%d reason=%s",
            result["severity"], delta["variantId"], delta["warehouseId"],
            delta["quantityBefore"], delta["quantityAfter"], result["reason"],
        )

    for record in flagged:
        reconcile_external(record)

    log.info("Done. %d desynced pair(s) %s.", len(flagged), "would reconcile" if DRY_RUN else "reconciled")
    return current_snapshot, flagged


if __name__ == "__main__":
    run()
