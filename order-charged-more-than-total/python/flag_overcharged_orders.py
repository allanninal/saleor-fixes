"""Flag Saleor orders where totalCharged plus totalAuthorized exceeds the
order total, because Saleor tracks authorizedAmount and chargedAmount
independently per TransactionItem and aggregates them without a hard cap
against order.total (see saleor/saleor#4162, saleor/saleor#7399, and the
order.chargeStatus OVERCHARGED value in the docs).

This script never calls orderGrantedRefundCreate or
transactionRequestRefundForGrantedRefund by default. Under DRY_RUN=true (the
default) it only logs the proposed granted refund input for each overcharged
order for a human to review. The guarded repair path (create_granted_refund)
is opt-in only, meant to run after a human approves the amount, and should
only ever run with DRY_RUN=false. Run on a schedule. Safe to run again and
again, since it never writes anything on its own.

Guide: https://www.allanninal.dev/saleor/order-charged-more-than-total/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_overcharged_orders")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
EPSILON = float(os.environ.get("OVERCHARGE_EPSILON", "0.005"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDERS_QUERY = """
query FlagOverchargedOrders($first: Int!, $after: String) {
  orders(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        chargeStatus
        totalCharged { amount currency }
        totalAuthorized { amount currency }
        totalBalance { amount currency }
        total { gross { amount currency } }
        transactions {
          id
          chargedAmount { amount }
          authorizedAmount { amount }
          refundedAmount { amount }
        }
      }
    }
  }
}"""

GRANTED_REFUND_CREATE = """
mutation($orderId: ID!, $amount: PositiveDecimal!, $reason: String!) {
  orderGrantedRefundCreate(orderId: $orderId, input: { amount: $amount, reason: $reason }) {
    orderGrantedRefund { id amount { amount } }
    errors { field code message }
  }
}"""

# Opt-in only. Never called by run(). Only fire after a human approves the
# grantedRefund record created above, and only with DRY_RUN=false.
REQUEST_REFUND_FOR_GRANTED_REFUND = """
mutation($transactionId: ID!, $grantedRefundId: ID!) {
  transactionRequestRefundForGrantedRefund(id: $transactionId, grantedRefundId: $grantedRefundId) {
    transaction { id }
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


def decide_overcharge_flag(order, transactions=None, epsilon=0.005):
    """Pure decision function. No I/O.

    order: {"totalGrossAmount": float, "totalCharged": float, "totalAuthorized": float, "currency": str}
    transactions: list of {"chargedAmount": float, "authorizedAmount": float}, or None/[] to fall
      back to order.totalCharged / order.totalAuthorized.

    Returns {"isOvercharged": bool, "capturedPlusAuthorized": float, "overageAmount": float}.
    """
    transactions = transactions or []
    if transactions:
        captured_plus_authorized = sum(
            (t.get("chargedAmount") or 0) + (t.get("authorizedAmount") or 0)
            for t in transactions
        )
    else:
        captured_plus_authorized = (order.get("totalCharged") or 0) + (order.get("totalAuthorized") or 0)

    total_gross = order.get("totalGrossAmount") or 0
    overage_amount = captured_plus_authorized - total_gross
    is_overcharged = overage_amount > epsilon

    return {
        "isOvercharged": is_overcharged,
        "capturedPlusAuthorized": captured_plus_authorized,
        "overageAmount": max(overage_amount, 0.0) if is_overcharged else 0.0,
    }


def all_orders(page_size=50):
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"first": page_size, "after": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def create_granted_refund(order_id, overage_amount, reason):
    """Opt-in only. Never called by run(). Wire in yourself after a human
    approves the flagged overage amount."""
    result = gql(GRANTED_REFUND_CREATE, {
        "orderId": order_id,
        "amount": round(overage_amount, 2),
        "reason": reason,
    })["orderGrantedRefundCreate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["orderGrantedRefund"]["id"]


def request_refund_for_granted_refund(transaction_id, granted_refund_id):
    """Opt-in only. Never called by run(). Executes the refund against the
    gateway once a granted refund has been approved."""
    result = gql(REQUEST_REFUND_FOR_GRANTED_REFUND, {
        "transactionId": transaction_id,
        "grantedRefundId": granted_refund_id,
    })["transactionRequestRefundForGrantedRefund"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["transaction"]["id"]


def to_plain(node):
    return {
        "id": node["id"],
        "number": node["number"],
        "chargeStatus": node["chargeStatus"],
        "totalCharged": (node.get("totalCharged") or {}).get("amount") or 0,
        "totalAuthorized": (node.get("totalAuthorized") or {}).get("amount") or 0,
        "totalBalance": (node.get("totalBalance") or {}).get("amount") or 0,
        "totalGrossAmount": (node.get("total") or {}).get("gross", {}).get("amount") or 0,
        "currency": (node.get("total") or {}).get("gross", {}).get("currency"),
    }


def to_plain_transactions(node):
    return [
        {
            "id": t["id"],
            "chargedAmount": (t.get("chargedAmount") or {}).get("amount") or 0,
            "authorizedAmount": (t.get("authorizedAmount") or {}).get("amount") or 0,
            "refundedAmount": (t.get("refundedAmount") or {}).get("amount") or 0,
        }
        for t in (node.get("transactions") or [])
    ]


def run():
    flagged = 0

    for node in all_orders():
        order = to_plain(node)
        transactions = to_plain_transactions(node)
        decision = decide_overcharge_flag(order, transactions, EPSILON)
        if not decision["isOvercharged"]:
            continue

        report_entry = {
            "orderId": order["id"],
            "number": order["number"],
            "chargeStatus": order["chargeStatus"],
            "capturedPlusAuthorized": decision["capturedPlusAuthorized"],
            "orderTotal": order["totalGrossAmount"],
            "overageAmount": round(decision["overageAmount"], 2),
            "totalBalance": order["totalBalance"],
            "transactions": transactions,
        }
        log.warning("Overcharged order found. %s %s", report_entry,
                    "(dry run, reporting only)" if DRY_RUN else "(reporting only, refund requires approval)")
        flagged += 1

        proposed_input = {
            "orderId": order["id"],
            "amount": round(decision["overageAmount"], 2),
            "reason": "Overcharge auto-detected: captured+authorized exceeded order total",
        }
        log.info("Proposed grantedRefund input: %s", proposed_input)

    log.info("Done. %d overcharged order(s) flagged for review.", flagged)


if __name__ == "__main__":
    run()
