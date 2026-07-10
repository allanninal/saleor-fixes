"""Find Saleor orders that are old, unpaid, and still holding a stock
allocation nothing is going to release, because expireOrdersAfter defaults
to null and only ever covers UNCONFIRMED orders with no payment attached
(see saleor/saleor#11257, Order Expiration and Order Status docs).

This script never cancels a partially fulfilled order. Under DRY_RUN=true
(the default) it only logs what it would do. When DRY_RUN=false, it calls
orderCancel for UNCONFIRMED or fully UNFULFILLED orders, which releases
every allocation on the order as a side effect. PARTIALLY_FULFILLED orders
are only ever flagged for a human, never auto-cancelled. Run on a schedule.
Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/unpaid-orders-retain-allocated-stock/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_stuck_orders")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
STALE_AFTER_HOURS = float(os.environ.get("STALE_AFTER_HOURS", "72"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RESOLVED_STATUSES = {"CANCELED", "EXPIRED", "FULFILLED"}
STUCK_STATUSES = {"UNFULFILLED", "UNCONFIRMED", "PARTIALLY_FULFILLED"}
UNPAID_PAYMENT_STATUSES = {"NOT_CHARGED", "REFUNDED", "VOIDED", "CANCELED"}

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor, sortBy: { field: CREATION_DATE, direction: ASC }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        isPaid
        paymentStatus
        created
        channel { slug orderSettings { expireOrdersAfter } }
        lines { id quantity quantityFulfilled variant { id } }
      }
    }
  }
}"""

ORDER_CANCEL = """
mutation($id: ID!) {
  orderCancel(id: $id) {
    order { id status }
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


def classify_stuck_order(order, now, stale_after_hours):
    """Pure decision function. order is a plain dict shaped like:
    {status, isPaid, paymentStatus, createdAt (datetime), channelExpireOrdersAfterMin}
    Returns one of 'OK', 'CANCEL', 'DEALLOCATE_ONLY'.
    """
    if order["status"] in RESOLVED_STATUSES or order["isPaid"]:
        return "OK"

    age_hours = (now - order["createdAt"]).total_seconds() / 3600

    expire_after = order.get("channelExpireOrdersAfterMin")
    if order["status"] == "UNCONFIRMED" and expire_after is not None:
        if age_hours * 60 < expire_after:
            return "OK"  # native expiration will still handle it

    if (
        age_hours > stale_after_hours
        and order["paymentStatus"] in UNPAID_PAYMENT_STATUSES
        and order["status"] in STUCK_STATUSES
    ):
        if order["status"] == "PARTIALLY_FULFILLED":
            return "DEALLOCATE_ONLY"
        return "CANCEL"  # UNCONFIRMED or UNFULFILLED, nothing shipped

    return "OK"


def has_open_allocation(order):
    for line in order.get("lines") or []:
        if line["quantity"] > line["quantityFulfilled"]:
            return True
    return False


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def cancel_order(order_id):
    result = gql(ORDER_CANCEL, {"id": order_id})["orderCancel"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["order"]["status"]


def to_plain(node):
    channel = node.get("channel") or {}
    settings = channel.get("orderSettings") or {}
    return {
        "id": node["id"],
        "number": node["number"],
        "status": node["status"],
        "isPaid": node["isPaid"],
        "paymentStatus": node["paymentStatus"],
        "createdAt": datetime.datetime.fromisoformat(node["created"].replace("Z", "+00:00")),
        "channelExpireOrdersAfterMin": settings.get("expireOrdersAfter"),
        "lines": node["lines"],
    }


def run():
    now = datetime.datetime.now(datetime.timezone.utc)
    cancelled = 0
    flagged = 0

    for node in all_orders():
        order = to_plain(node)
        if not has_open_allocation(order):
            continue

        decision = classify_stuck_order(order, now, STALE_AFTER_HOURS)
        if decision == "OK":
            continue

        log.info(
            "%s",
            {
                "orderId": order["id"],
                "number": order["number"],
                "previousStatus": order["status"],
                "action": "orderCancel" if decision == "CANCEL" else "flag_for_review",
            },
        )

        if decision == "CANCEL":
            if not DRY_RUN:
                cancel_order(order["id"])
            cancelled += 1
        else:
            flagged += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for human review.",
        cancelled, "to cancel" if DRY_RUN else "cancelled", flagged,
    )


if __name__ == "__main__":
    run()
