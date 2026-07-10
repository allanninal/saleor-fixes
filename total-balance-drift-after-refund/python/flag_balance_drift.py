"""Find Saleor orders where totalBalance no longer reconciles with
total, totalCaptured, and totalRefunded, because totalBalance is derived
at read time from whatever TransactionItem events happen to exist, and a
partial refund or an authorization adjustment can update one field
without a matching correction to the others (see saleor/saleor#12297,
saleor/saleor#11445, discussion #15458).

Under DRY_RUN=true (the default) this script only reports drifted
orders, it never writes a correcting event. A correction is only ever
recorded when DRY_RUN=false, and only after a human has signed off on
the specific transaction, event type, and amount, since the right fix
depends on reading the actual raw events. Run on a schedule. Safe to
run again and again.

Guide: https://www.allanninal.dev/saleor/total-balance-drift-after-refund/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_balance_drift")

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
        totalRefunded { amount }
        totalBalance { amount }
      }
    }
  }
}"""

REPORT_EVENT = """
mutation($id: ID!, $type: TransactionEventTypeEnum!, $amount: Decimal!) {
  transactionEventReport(id: $id, type: $type, amount: $amount) {
    transaction { id }
    errors { field message code }
  }
}"""

ORDER_BALANCE_CHECK = """
query($id: ID!) {
  order(id: $id) {
    id
    total { gross { amount } }
    totalCaptured { amount }
    totalRefunded { amount }
    totalBalance { amount }
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


def classify_balance_drift(total, total_captured, total_refunded, reported_balance):
    """Pure decision function. No I/O.

    All amounts are plain numbers, the same units Saleor reports them in.
    Returns {"status": "OK"|"BALANCE_DRIFTED", "expectedBalance", "reportedBalance", "driftedBy"}.
    """
    expected_balance = round(total - total_captured + total_refunded, 2)
    drifted_by = round(reported_balance - expected_balance, 2)

    if abs(drifted_by) <= EPSILON:
        return {
            "status": "OK",
            "expectedBalance": expected_balance,
            "reportedBalance": reported_balance,
            "driftedBy": 0,
        }

    return {
        "status": "BALANCE_DRIFTED",
        "expectedBalance": expected_balance,
        "reportedBalance": reported_balance,
        "driftedBy": drifted_by,
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


def record_correcting_event(transaction_id, event_type, amount):
    result = gql(REPORT_EVENT, {"id": transaction_id, "type": event_type, "amount": amount})["transactionEventReport"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["transaction"]["id"]


def confirm_reconciled(order_id):
    order = gql(ORDER_BALANCE_CHECK, {"id": order_id})["order"]
    result = classify_balance_drift(
        order["total"]["gross"]["amount"],
        order["totalCaptured"]["amount"],
        order["totalRefunded"]["amount"],
        order["totalBalance"]["amount"],
    )
    return result["status"] == "OK"


def to_plain(node):
    return {
        "id": node["id"],
        "number": node["number"],
        "total": node["total"]["gross"]["amount"],
        "totalCaptured": node["totalCaptured"]["amount"],
        "totalRefunded": node["totalRefunded"]["amount"],
        "totalBalance": node["totalBalance"]["amount"],
    }


def run(pending_corrections=None):
    """pending_corrections maps orderId -> (transactionId, eventType, amount),
    populated only from a signed-off review, never guessed by the script."""
    pending_corrections = pending_corrections or {}
    reported = 0
    corrected = 0

    for node in all_orders():
        order = to_plain(node)
        result = classify_balance_drift(
            order["total"], order["totalCaptured"], order["totalRefunded"], order["totalBalance"]
        )
        if result["status"] == "OK":
            continue

        report_row = {
            "orderId": order["id"],
            "orderNumber": order["number"],
            "expectedBalance": result["expectedBalance"],
            "reportedBalance": result["reportedBalance"],
            "driftedBy": result["driftedBy"],
        }
        log.warning("Balance-drifted order found for finance review: %s", report_row)
        reported += 1

        # Correcting the ledger is never automatic. This branch only ever runs
        # for an order a human has signed off on, with the exact transaction,
        # event type, and amount they decided on after reading the raw events.
        correction = pending_corrections.get(order["id"])
        if not DRY_RUN and correction:
            transaction_id, event_type, amount = correction
            log.info("Recording correcting event on transaction %s (signed off).", transaction_id)
            record_correcting_event(transaction_id, event_type, amount)
            if confirm_reconciled(order["id"]):
                log.info("Order %s reconciled. totalBalance now matches.", order["number"])
            else:
                log.error("Order %s still drifted after correction. Needs manual review.", order["number"])
            corrected += 1

    log.info("Done. %d order(s) reported drifted, %d correction(s) recorded.", reported, corrected)


if __name__ == "__main__":
    run()
