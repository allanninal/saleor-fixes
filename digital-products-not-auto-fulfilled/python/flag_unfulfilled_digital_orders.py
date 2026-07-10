"""Find Saleor orders that stayed Unfulfilled despite automatic digital
fulfillment being enabled, report them, and optionally fulfill the
confirmed-safe ones.

automatic_fulfillment_digital_products, and the per-DigitalContent override,
are only read from inside automatically_fulfill_digital_lines(), which runs
during the payment-capture success path when an order becomes fully paid
through a real payment or transaction event during checkout completion.
Orders that become paid through orderMarkAsPaid, draft order completion, a
manual transaction adjustment, or a webhook outside that signal never call
that function, so their digital-only lines stay Unfulfilled even with the
setting on. A digital variant with no warehouse Stock row is skipped the
same way, since the routine still needs a stock row to build a
FulfillmentLine.

This is flag and report, with an optional orderFulfill call gated by
DRY_RUN, and only for orders that are fully paid through the real payment
path, entirely digital, and backed by stock on every line. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/digital-products-not-auto-fulfilled/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_unfulfilled_digital_orders")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
SHOP_DEFAULT_AUTO_FULFILL = os.environ.get("SHOP_AUTOMATIC_FULFILLMENT_DIGITAL", "true").lower() == "true"
WAREHOUSE_ID = os.environ.get("SALEOR_WAREHOUSE_ID", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ELIGIBLE_STATUSES = {"UNFULFILLED", "PARTIALLY_FULFILLED"}
PAID_VIA_REAL_PAYMENT = {"CHECKOUT_CAPTURE", "TRANSACTION_ACTION"}
MARK_AS_PAID_EVENT = "ORDER_MARKED_AS_PAID"

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 100, after: $cursor, filter: { isFulfilled: false }) {
    edges {
      node {
        id
        number
        status
        isPaid
        lines {
          id
          isShippingRequired
          variant {
            id
            digitalContent { useDefaultSettings automaticFulfillment }
          }
        }
        events { type }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}"""

WAREHOUSES_QUERY = """
query {
  warehouses(first: 100) {
    edges { node { id stocks { productVariant { id } quantity } } }
  }
}"""

FULFILL_MUTATION = """
mutation($order: ID!, $lines: [OrderFulfillLineInput!]!) {
  orderFulfill(order: $order, input: {
    lines: $lines, notifyCustomer: true, allowStockToBeExceeded: false
  }) {
    fulfillments { id status }
    errors { field code message }
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


def should_auto_fulfill(order, shop_default):
    """
    Pure decision logic, no I/O.
    order: {"is_paid": bool, "status": str, "paid_via": str,
            "lines": [{"is_shipping_required": bool,
                       "digital_content": {"use_default_settings": bool,
                                           "automatic_fulfillment": bool} or None,
                       "has_stock": bool}]}
    Returns True only when the order is confirmed safe to auto-fulfill:
    paid through a real payment path, still unfulfilled or partially
    fulfilled, every line digital and stocked, and the effective per-line
    automatic fulfillment flag (override if use_default_settings is False,
    else the shop default) is True for every line.
    """
    if not order.get("is_paid"):
        return False
    if order.get("status") not in ELIGIBLE_STATUSES:
        return False
    if order.get("paid_via") not in PAID_VIA_REAL_PAYMENT:
        return False

    lines = order.get("lines") or []
    if not lines:
        return False

    for line in lines:
        if line.get("is_shipping_required"):
            return False
        if not line.get("has_stock"):
            return False

        content = line.get("digital_content")
        if content is None:
            return False
        if content.get("use_default_settings") is False:
            effective = content.get("automatic_fulfillment")
        else:
            effective = shop_default
        if not effective:
            return False

    return True


def paid_via(order):
    events = order.get("events") or []
    if any(e.get("type") == MARK_AS_PAID_EVENT for e in events):
        return "MARK_AS_PAID"
    return "CHECKOUT_CAPTURE"


def variant_ids_with_stock():
    data = gql(WAREHOUSES_QUERY)["warehouses"]
    stocked = set()
    for edge in data["edges"]:
        for stock in edge["node"]["stocks"]:
            if stock["quantity"] and stock["quantity"] > 0:
                stocked.add(stock["productVariant"]["id"])
    return stocked


def normalize_order(node, stocked_variant_ids):
    lines = []
    for line in node["lines"]:
        variant = line.get("variant") or {}
        content = variant.get("digitalContent")
        digital_content = None
        if content is not None:
            digital_content = {
                "use_default_settings": content.get("useDefaultSettings"),
                "automatic_fulfillment": content.get("automaticFulfillment"),
            }
        lines.append({
            "id": line["id"],
            "is_shipping_required": line.get("isShippingRequired", True),
            "digital_content": digital_content,
            "has_stock": variant.get("id") in stocked_variant_ids,
        })
    return {
        "id": node["id"],
        "number": node["number"],
        "is_paid": node.get("isPaid", False),
        "status": node.get("status"),
        "paid_via": paid_via(node),
        "lines": lines,
    }


def unfulfilled_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def fulfill_order(order_id, line_ids):
    lines = [
        {"orderLineId": lid, "stocks": [{"quantity": 1, "warehouse": WAREHOUSE_ID}]}
        for lid in line_ids
    ]
    result = gql(FULFILL_MUTATION, {"order": order_id, "lines": lines})["orderFulfill"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["fulfillments"]


def run():
    stocked_variant_ids = variant_ids_with_stock()
    flagged = 0
    fulfilled = 0
    for node in unfulfilled_orders():
        order = normalize_order(node, stocked_variant_ids)
        if not should_auto_fulfill(order, SHOP_DEFAULT_AUTO_FULFILL):
            continue

        flagged += 1
        log.warning(
            "Order %s paid via %s, all digital, has stock, still %s. %s",
            order["number"], order["paid_via"], order["status"],
            "would fulfill" if DRY_RUN else "fulfilling",
        )

        if not DRY_RUN and WAREHOUSE_ID:
            line_ids = [line["id"] for line in order["lines"]]
            fulfill_order(order["id"], line_ids)
            fulfilled += 1

    log.info(
        "Done. %d order(s) flagged, %d %s.",
        flagged, fulfilled, "would be fulfilled" if DRY_RUN else "fulfilled",
    )
    return flagged


if __name__ == "__main__":
    run()
