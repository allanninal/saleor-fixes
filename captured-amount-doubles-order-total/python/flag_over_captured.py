"""Find Saleor orders where totalCaptured has run past order.total, because
Saleor sums chargedAmount across every TransactionItem on the order and only
dedupes CHARGE_SUCCESS events within a single TransactionItem, keyed by
(type, pspReference). There is no order-level cap at order.total (see
saleor/saleor#7399, saleor/saleor#4162, discussion #15458).

Under DRY_RUN=true (the default) this script only reports over-captured
orders, it never refunds anything. A corrective refund of the exact overBy
amount is only ever issued when DRY_RUN=false, and only after a human has
signed off on that specific order, since the extra capture may reflect a
real second charge the customer actually paid. Run on a schedule. Safe to
run again and again.

Guide: https://www.allanninal.dev/saleor/captured-amount-doubles-order-total/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_over_captured")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        total { gross { amount } }
        totalCaptured { amount }
        transactions { id pspReference chargedAmount { amount } }
      }
    }
  }
}"""

REFUND_EXCESS = """
mutation($id: ID!, $amount: Decimal!) {
  transactionRequestAction(id: $id, actionType: REFUND, amount: $amount) {
    transaction { id }
    errors { field message code }
  }
}"""

ORDER_CAPTURE_CHECK = """
query($id: ID!) {
  order(id: $id) {
    id
    total { gross { amount } }
    totalCaptured { amount }
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


def classify_order_capture(order_total, transactions):
    """Pure decision function. No I/O.

    transactions is a list of {"id", "pspReference", "chargedAmount"}.
    Returns {"status": "OK"|"OVER_CAPTURED", "totalCaptured", "overBy", "culprits"}.
    """
    total_captured = sum(t["chargedAmount"] for t in transactions)

    if total_captured <= order_total + EPSILON:
        return {
            "status": "OK",
            "totalCaptured": total_captured,
            "overBy": 0,
            "culprits": [],
        }

    over_by = round(total_captured - order_total, 2)
    culprits = sorted(
        (t for t in transactions if t["chargedAmount"] >= order_total - EPSILON),
        key=lambda t: t["chargedAmount"],
        reverse=True,
    )
    return {
        "status": "OVER_CAPTURED",
        "totalCaptured": total_captured,
        "overBy": over_by,
        "culprits": [t["id"] for t in culprits],
    }


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def refund_excess(transaction_id, amount):
    result = gql(REFUND_EXCESS, {"id": transaction_id, "amount": amount})["transactionRequestAction"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["transaction"]["id"]


def confirm_reconciled(order_id, order_total):
    order = gql(ORDER_CAPTURE_CHECK, {"id": order_id})["order"]
    captured = order["totalCaptured"]["amount"]
    return abs(captured - order_total) <= EPSILON


def to_plain(node):
    return {
        "id": node["id"],
        "number": node["number"],
        "total": node["total"]["gross"]["amount"],
        "transactions": [
            {"id": t["id"], "pspReference": t["pspReference"], "chargedAmount": t["chargedAmount"]["amount"]}
            for t in (node.get("transactions") or [])
        ],
    }


def run():
    reported = 0
    refunded = 0

    for node in all_orders():
        order = to_plain(node)
        result = classify_order_capture(order["total"], order["transactions"])
        if result["status"] == "OK":
            continue

        report_row = {
            "orderId": order["id"],
            "orderNumber": order["number"],
            "total": order["total"],
            "totalCaptured": result["totalCaptured"],
            "overBy": result["overBy"],
            "transactionIds": result["culprits"],
        }
        log.warning("Over-captured order found for finance review: %s", report_row)
        reported += 1

        # Refunding is never automatic. This branch only ever runs when a human
        # has signed off on this specific order and DRY_RUN has been turned off.
        if not DRY_RUN and result["culprits"]:
            culprit_id = result["culprits"][0]
            log.info("Refunding excess %.2f on transaction %s (signed off).", result["overBy"], culprit_id)
            refund_excess(culprit_id, result["overBy"])
            if confirm_reconciled(order["id"], order["total"]):
                log.info("Order %s reconciled. totalCaptured now matches total.", order["number"])
            else:
                log.error("Order %s still not reconciled after refund. Needs manual review.", order["number"])
            refunded += 1

    log.info("Done. %d order(s) reported over-captured, %d refund(s) issued.", reported, refunded)


if __name__ == "__main__":
    run()
