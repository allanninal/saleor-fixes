"""Flag Saleor orders that are paid but still UNFULFILLED because nothing
ever called orderFulfill, because order.status is driven only by whether a
Fulfillment record exists, completely decoupled from isPaid or paymentStatus
(see saleor/saleor#4794, the Order object docs, and the OrderFilterInput docs).

This script never calls orderFulfill by default. Under DRY_RUN=true (the
default) it only logs a report entry for each stuck order for staff triage.
The guarded auto-repair path (fulfill_order) is opt-in only, meant for a
narrow, explicitly configured scenario, and should only ever run with fresh
stock data and DRY_RUN=false. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/order-stuck-unfulfilled-after-payment/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stuck_unfulfilled")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
STALE_AFTER_MINUTES = float(os.environ.get("STALE_AFTER_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_CHARGE_STATUSES = {"FULLY_CHARGED", "PARTIALLY_CHARGED"}

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
        channel { slug }
        total { gross { amount currency } }
        totalCharged { amount }
        created
        updatedAt
        fulfillments { id status }
      }
    }
  }
}"""

# Optional, opt-in only. Not called by the default flag-and-report flow.
ORDER_FULFILL = """
mutation($order: ID!, $input: OrderFulfillInput!) {
  orderFulfill(order: $order, input: $input) {
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


def classify_stuck_order(status, is_paid, payment_charge_status, fulfillments,
                          updated_at, now, stale_minutes=30):
    """Pure decision logic, no I/O.

    1. If status is not UNFULFILLED, the order already moved on (or was
       cancelled), so it is not stuck.
    2. If it is not paid (isPaid True or a charged paymentStatus), it is
       correctly waiting on payment, not stuck.
    3. If it already has an active (non-cancelled) fulfillment, the status
       field just has not recomputed yet, a separate bug class, not this one.
    4. If it has not aged past stale_minutes, it is still inside the normal
       staff-processing window.
    5. Otherwise it is genuinely stuck: paid, unfulfilled, no fulfillment,
       and old enough that something should have happened by now.
    """
    if status != "UNFULFILLED":
        return {"stuck": False, "reason": "not_unfulfilled"}

    paid = bool(is_paid) or payment_charge_status in PAID_CHARGE_STATUSES
    if not paid:
        return {"stuck": False, "reason": "not_paid"}

    active_fulfillments = [f for f in (fulfillments or []) if f.get("status") != "CANCELED"]
    if active_fulfillments:
        return {"stuck": False, "reason": "has_active_fulfillment"}

    age_minutes = (now - updated_at).total_seconds() / 60
    if age_minutes < stale_minutes:
        return {"stuck": False, "reason": "within_processing_window"}

    return {"stuck": True, "reason": "paid_but_no_fulfillment_past_threshold"}


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def fulfill_order(order_id, lines):
    """Opt-in only. Never called by run(). Wire in yourself for a narrow,
    explicitly configured scenario (for example digital or gift-card-only
    orders), always with fresh stock data pulled just before the call, and
    only when DRY_RUN=false."""
    result = gql(ORDER_FULFILL, {"order": order_id, "input": {"lines": lines, "notifyCustomer": True}})["orderFulfill"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["fulfillments"]


def to_plain(node):
    return {
        "id": node["id"],
        "number": node["number"],
        "status": node["status"],
        "isPaid": node["isPaid"],
        "paymentStatus": node["paymentStatus"],
        "channel": (node.get("channel") or {}).get("slug"),
        "paidAmount": (node.get("totalCharged") or {}).get("amount"),
        "updatedAt": datetime.datetime.fromisoformat(node["updatedAt"].replace("Z", "+00:00")),
    }


def run():
    now = datetime.datetime.now(datetime.timezone.utc)
    flagged = 0

    for node in all_orders():
        order = to_plain(node)
        decision = classify_stuck_order(
            order["status"], order["isPaid"], order["paymentStatus"],
            node["fulfillments"], order["updatedAt"], now, STALE_AFTER_MINUTES,
        )
        if not decision["stuck"]:
            continue

        age_minutes = (now - order["updatedAt"]).total_seconds() / 60
        report_entry = {
            "orderId": order["id"],
            "number": order["number"],
            "channel": order["channel"],
            "paidAmount": order["paidAmount"],
            "ageMinutes": round(age_minutes, 1),
        }
        log.warning("Stuck order found. %s %s", report_entry, "(dry run, reporting only)" if DRY_RUN else "(reporting only)")
        flagged += 1

    log.info("Done. %d stuck order(s) flagged for staff triage.", flagged)


if __name__ == "__main__":
    run()
