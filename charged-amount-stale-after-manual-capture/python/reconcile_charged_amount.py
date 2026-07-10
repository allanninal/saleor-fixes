"""Reconcile Saleor orders whose charged amount stays stale after a manual capture.

Saleor's totalCharged and TransactionItem.chargedAmount only recalculate from
reported TransactionEvent records, never live from the gateway. A manual capture
made outside the normal event flow leaves chargePendingAmount open until an app
reports it back. This script cross-checks stalled transactions against the
gateway by pspReference and reports the confirmed state back with
transactionEventReport. Ambiguous mismatches are flagged for finance, never
auto-written. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/charged-amount-stale-after-manual-capture/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_charged_amount")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
GATEWAY_API_URL = os.environ.get("GATEWAY_API_URL", "https://gateway.example.com/v1")
GATEWAY_API_KEY = os.environ.get("GATEWAY_API_KEY", "dummy-key")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 25, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id number chargeStatus isPaid
        totalCharged { amount currency }
        totalAuthorized { amount currency }
        transactions {
          id pspReference
          chargedAmount { amount currency }
          chargePendingAmount { amount currency }
          authorizedAmount { amount currency }
          events { type pspReference createdAt }
        }
      }
    }
  }
}"""

REPORT_MUTATION = """
mutation TransactionEventReport($id: ID!, $type: TransactionEventTypeEnum!, $amount: PositiveDecimal!, $pspReference: String!, $availableActions: [TransactionActionEnum!]) {
  transactionEventReport(id: $id, type: $type, amount: $amount, pspReference: $pspReference, availableActions: $availableActions) {
    alreadyReported
    transaction { id chargedAmount { amount } }
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


def fetch_gateway_capture(psp_reference):
    r = requests.get(
        f"{GATEWAY_API_URL}/charges/{psp_reference}",
        headers={"Authorization": f"Bearer {GATEWAY_API_KEY}"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    return {
        "pspReference": psp_reference,
        "capturedAmount": body["capturedAmount"],
        "status": body["status"],
    }


def classify_charge_reconciliation(saleor_txn, gateway_capture):
    """Pure decision function. No I/O.

    saleor_txn: {"chargedAmount": number, "chargePendingAmount": number, "events": [{"type": str, "pspReference": str}]}
    gateway_capture: {"pspReference": str, "capturedAmount": number, "status": "succeeded" | "failed" | "pending"}

    Returns one of: "IN_SYNC" | "NEEDS_REPORT_SUCCESS" | "NEEDS_REPORT_FAILURE" | "AMOUNT_MISMATCH_FLAG"
    """
    status = gateway_capture["status"]

    if status == "pending":
        return "IN_SYNC"

    if status == "succeeded":
        has_matching_success = any(
            e.get("type") == "CHARGE_SUCCESS" and e.get("pspReference") == gateway_capture["pspReference"]
            for e in saleor_txn.get("events", [])
        )
        if not has_matching_success:
            if saleor_txn["chargedAmount"] < gateway_capture["capturedAmount"]:
                return "NEEDS_REPORT_SUCCESS"
            if saleor_txn["chargedAmount"] > gateway_capture["capturedAmount"]:
                return "AMOUNT_MISMATCH_FLAG"
        return "IN_SYNC"

    if status == "failed" and saleor_txn.get("chargePendingAmount", 0) > 0:
        return "NEEDS_REPORT_FAILURE"

    return "IN_SYNC"


def report_event(transaction_id, event_type, amount, psp_reference):
    result = gql(REPORT_MUTATION, {
        "id": transaction_id,
        "type": event_type,
        "amount": amount,
        "pspReference": psp_reference,
        "availableActions": [],
    })["transactionEventReport"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result


def candidate_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def run():
    reported = 0
    flagged = 0
    for order in candidate_orders():
        for txn in order.get("transactions", []):
            psp_reference = txn.get("pspReference")
            pending = (txn.get("chargePendingAmount") or {}).get("amount", 0)
            if not psp_reference or not pending:
                continue

            saleor_txn = {
                "chargedAmount": (txn.get("chargedAmount") or {}).get("amount", 0),
                "chargePendingAmount": pending,
                "events": txn.get("events", []),
            }
            gateway_capture = fetch_gateway_capture(psp_reference)
            decision = classify_charge_reconciliation(saleor_txn, gateway_capture)

            if decision == "NEEDS_REPORT_SUCCESS":
                log.info("Order %s txn %s: gateway confirms capture. %s",
                          order["number"], txn["id"], "would report" if DRY_RUN else "reporting")
                if not DRY_RUN:
                    report_event(txn["id"], "CHARGE_SUCCESS", gateway_capture["capturedAmount"], psp_reference)
                reported += 1
            elif decision == "NEEDS_REPORT_FAILURE":
                log.info("Order %s txn %s: gateway confirms failure. %s",
                          order["number"], txn["id"], "would report" if DRY_RUN else "reporting")
                if not DRY_RUN:
                    report_event(txn["id"], "CHARGE_FAILURE", pending, psp_reference)
                reported += 1
            elif decision == "AMOUNT_MISMATCH_FLAG":
                log.warning("Order %s txn %s: amount mismatch, flagged for finance review.",
                            order["number"], txn["id"])
                flagged += 1

    log.info("Done. %d event(s) %s, %d flagged for review.",
              reported, "to report" if DRY_RUN else "reported", flagged)


if __name__ == "__main__":
    run()
