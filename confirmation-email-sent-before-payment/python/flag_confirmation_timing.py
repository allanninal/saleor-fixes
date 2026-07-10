"""Flag Saleor orders whose confirmation email fired before the payment ever
succeeded, because send_order_confirmation runs synchronously inside
checkoutComplete at order-creation time, never gated on a successful
CHARGE_SUCCESS or AUTHORIZATION_SUCCESS transaction event (see saleor/saleor#3527
and the TransactionEvent and Order object docs).

This script never un-sends an email, since Saleor has no mutation for that.
Under DRY_RUN=true (the default) it only logs a report entry for each flagged
order for support follow-up. Only orders that clear CANCEL_GRACE_HOURS with
still no successful charge are cancelled with orderCancel, and only when
DRY_RUN=false. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_confirmation_timing")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
CANCEL_GRACE_HOURS = float(os.environ.get("CANCEL_GRACE_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDERS_QUERY = """
query OrdersWithTimeline($first: Int!, $after: String) {
  orders(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id number isPaid status created
        events { type date }
        payments { id isActive transactions { id kind isSuccess created } }
      }
    }
  }
}"""

TRANSACTIONS_QUERY = """
query OrderTransactions($id: ID!) {
  order(id: $id) {
    id isPaid
    transactions { id events { type createdAt pspReference } }
  }
}"""

CANCEL_ORDER = """
mutation CancelUnpaidOrder($id: ID!) {
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


def confirm_event_timestamp(order):
    """Return the ISO timestamp of the order's PLACED event, or None."""
    for event in order.get("events") or []:
        if event.get("type") == "PLACED":
            return event.get("date")
    return None


def charge_success_timestamp(order, transactions):
    """Return the earliest successful charge timestamp for the order, or None.

    Prefers the current Transactions API (TransactionEvent type CHARGE_SUCCESS)
    and falls back to the legacy Payment/Transaction model (kind CAPTURE,
    isSuccess true) for deployments still on the old payments flow.
    """
    times = [
        e["createdAt"]
        for t in (transactions or [])
        for e in (t.get("events") or [])
        if e.get("type") == "CHARGE_SUCCESS"
    ]
    if not times:
        for payment in order.get("payments") or []:
            for tx in payment.get("transactions") or []:
                if tx.get("kind") == "CAPTURE" and tx.get("isSuccess"):
                    times.append(tx["created"])
    return min(times) if times else None


def decide_confirmation_timing_issue(confirm_event_ts, charge_success_ts, order_is_paid,
                                      now, cancel_grace_hours=24):
    """Pure decision function. No I/O, fully unit-testable.

    confirm_event_ts: datetime | None - when the PLACED event (and therefore
        send_order_confirmation) fired.
    charge_success_ts: datetime | None - earliest successful charge event, if any.
    order_is_paid: bool - order.isPaid at flag time.
    now: datetime - current time, passed in so the function stays pure.
    cancel_grace_hours: int - how long to wait before an unpaid order with a
        premature confirmation becomes eligible for cancellation.

    Returns one of "ok", "flag_email_premature", "flag_and_eligible_for_cancel".
    """
    if confirm_event_ts is None:
        return "ok"
    if charge_success_ts is not None and confirm_event_ts <= charge_success_ts:
        return "ok"
    if charge_success_ts is not None and confirm_event_ts > charge_success_ts:
        return "ok"
    if order_is_paid:
        return "ok"
    age_hours = (now - confirm_event_ts).total_seconds() / 3600
    if age_hours >= cancel_grace_hours:
        return "flag_and_eligible_for_cancel"
    return "flag_email_premature"


def parse_iso(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"first": 50, "after": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def fetch_transactions(order_id):
    return gql(TRANSACTIONS_QUERY, {"id": order_id})["order"]["transactions"]


def cancel_unpaid_order(order_id):
    result = gql(CANCEL_ORDER, {"id": order_id})["orderCancel"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["order"]["status"]


def run():
    now = datetime.datetime.now(datetime.timezone.utc)
    flagged = 0
    cancelled = 0

    for order in all_orders():
        confirm_iso = confirm_event_timestamp(order)
        if confirm_iso is None:
            continue

        transactions = fetch_transactions(order["id"])
        charge_iso = charge_success_timestamp(order, transactions)

        confirm_ts = parse_iso(confirm_iso)
        charge_ts = parse_iso(charge_iso) if charge_iso else None

        outcome = decide_confirmation_timing_issue(
            confirm_ts, charge_ts, order.get("isPaid", False), now, CANCEL_GRACE_HOURS
        )
        if outcome == "ok":
            continue

        flagged += 1
        report_entry = {
            "orderId": order["id"],
            "number": order["number"],
            "confirmEventTs": confirm_iso,
            "chargeSuccessTs": charge_iso,
            "isPaid": order.get("isPaid", False),
            "status": order.get("status"),
            "outcome": outcome,
        }
        log.warning("Confirmation timing issue found. %s", report_entry)

        if outcome == "flag_and_eligible_for_cancel":
            if not DRY_RUN:
                cancel_unpaid_order(order["id"])
                cancelled += 1
            else:
                log.info("Order %s would be cancelled (dry run).", order["number"])

    log.info("Done. %d order(s) flagged, %d cancelled.", flagged, cancelled)


if __name__ == "__main__":
    run()
