"""Flag Saleor orders that were reverted to DRAFT by editing a confirmed
order, because the dashboard and API have historically reused draft-order
line and address mutations against placed orders, which can silently write
order.status back to DRAFT instead of rejecting the edit (see
saleor/saleor#4978, saleor/saleor#3987, and the order status docs).

Because OrderStatusFilter has no DRAFT value, these orders are invisible to
any query filtered by status, so this script pages through every order with
no status filter and inspects the raw status field client-side.

This script never calls draftOrderComplete or orderCancel by default. Under
DRY_RUN=true (the default) it only logs a report entry for each flagged
order for staff review. The guarded repair path (complete_draft_order) is
opt-in only, meant to run after a human has reviewed the line and address
diff, and should only ever run with DRY_RUN=false. Run on a schedule. Safe
to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_orphaned_drafts")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        created
        payments { id isActive chargeStatus }
        transactions { id }
      }
    }
  }
}"""

# Opt-in only. Not called by the default flag-and-report flow. Run only after
# a human has reviewed the line and address diff on the flagged order.
DRAFT_ORDER_COMPLETE = """
mutation($id: ID!) {
  draftOrderComplete(id: $id) {
    order { id status }
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


def is_orphaned_draft_with_payment(order):
    if order.get("status") != "DRAFT":
        return False

    payments = order.get("payments") or []
    has_charged_payment = any(
        p.get("isActive") and p.get("chargeStatus") != "NOT_CHARGED" for p in payments
    )
    has_transaction = len(order.get("transactions") or []) > 0

    return has_charged_payment or has_transaction


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def complete_draft_order(order_id):
    """Opt-in only. Never called by run(). Wire in yourself only after a human
    has reviewed the line and address diff on the flagged order."""
    result = gql(DRAFT_ORDER_COMPLETE, {"id": order_id})["draftOrderComplete"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["order"]["status"]


def run():
    flagged = 0
    for order in all_orders():
        if not is_orphaned_draft_with_payment(order):
            continue

        payment_ids = [p["id"] for p in (order.get("payments") or [])]
        report_entry = {
            "orderId": order["id"],
            "number": order["number"],
            "paymentIds": payment_ids,
            "transactionCount": len(order.get("transactions") or []),
        }
        log.warning("Orphaned draft order found. %s %s", report_entry,
                    "(dry run, reporting only)" if DRY_RUN else "(reporting only)")
        flagged += 1

    log.info("Done. %d orphaned draft order(s) flagged for staff review.", flagged)


if __name__ == "__main__":
    run()
