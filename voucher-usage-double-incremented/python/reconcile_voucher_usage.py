"""Find Saleor voucher codes whose stored usage counter was double
incremented by a two-stage payment gateway calling checkoutComplete twice
for the same checkout, once for confirmationNeeded and once after the
customer confirms (see saleor/saleor#8219, the Voucher and VoucherCode
object docs, and the orders query docs).

This script never writes the usage counter. Saleor has no public
voucherCodeUsageSet mutation, so under DRY_RUN=true (the default, and the
only mode this script supports out of the box) it logs a report entry
for every overcounted code: {code, storedUsed, realUsage, delta}. Hand
that report to staff for a manual correction in the dashboard, or wire in
your own app-level correction mutation if you have built one. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/voucher-usage-double-incremented/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_voucher_usage")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
VOUCHER_ID = os.environ.get("SALEOR_VOUCHER_ID", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

COMPLETED_STATUSES = {"FULFILLED", "PARTIALLY_FULFILLED", "UNFULFILLED"}

VOUCHER_QUERY = """
query($id: ID!) {
  voucher(id: $id) {
    id
    usageLimit
    codes(first: 100) {
      edges { node { id code used } }
    }
  }
}"""

ORDERS_FOR_CODE_QUERY = """
query($code: String!, $cursor: String) {
  orders(first: 100, after: $cursor, filter: { voucherCode: $code }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node { id number created voucherCode status isPaid paymentStatus }
    }
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


def decide_voucher_usage_correction(code, qualifying_orders):
    """Pure decision function. code: {id, code, storedUsed}. qualifying_orders:
    list of {id, status, isPaid}. Returns {action, correctedUsed, delta}.

    Real usage counts only orders that actually completed: paid, or reached
    FULFILLED / PARTIALLY_FULFILLED / UNFULFILLED. Cancelled, draft, and
    abandoned-checkout artifacts never count. If stored usage is at or below
    real usage there is nothing to do (no overcount, or an out-of-scope
    undercount). If stored usage is higher, the code was overcounted by the
    difference, and the corrected value is the real usage.
    """
    real_usage = sum(
        1 for o in qualifying_orders
        if o.get("isPaid") or o.get("status") in COMPLETED_STATUSES
    )
    stored_used = code["storedUsed"]

    if stored_used <= real_usage:
        return {"action": "none", "correctedUsed": stored_used, "delta": 0}

    return {
        "action": "decrement",
        "correctedUsed": real_usage,
        "delta": stored_used - real_usage,
    }


def voucher_codes(voucher_id):
    data = gql(VOUCHER_QUERY, {"id": voucher_id})["voucher"]
    return [
        {"id": node["id"], "code": node["code"], "storedUsed": node["used"]}
        for node in (edge["node"] for edge in data["codes"]["edges"])
    ]


def orders_for_code(code):
    cursor = None
    while True:
        data = gql(ORDERS_FOR_CODE_QUERY, {"code": code, "cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def run():
    if not VOUCHER_ID:
        raise SystemExit("Set SALEOR_VOUCHER_ID to the voucher you want to reconcile.")

    flagged = 0
    for code in voucher_codes(VOUCHER_ID):
        qualifying_orders = list(orders_for_code(code["code"]))
        decision = decide_voucher_usage_correction(code, qualifying_orders)
        if decision["action"] == "none":
            continue

        report_entry = {
            "code": code["code"],
            "storedUsed": code["storedUsed"],
            "realUsage": decision["correctedUsed"],
            "delta": decision["delta"],
        }
        log.warning("Overcounted voucher code found. %s %s", report_entry,
                    "(dry run, reporting only)" if DRY_RUN else "(reporting only, no public write mutation)")
        flagged += 1

    log.info("Done. %d voucher code(s) flagged for staff correction.", flagged)


if __name__ == "__main__":
    run()
