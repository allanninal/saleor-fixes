"""Complete Saleor checkouts that were paid but never converted to an Order.

checkoutComplete is a separate mutation the storefront must call after the payment
provider confirms payment. If the tab closes, the app crashes, or the network drops
between the payment reaching authorizeStatus FULL and that final call, the Checkout
is left behind with money captured or authorized and no Order ever created.

This lists checkouts with authorizeStatus: FULL, keeps only the ones aged past a
grace period with no Order yet, and calls checkoutComplete for each. Anything still
needing provider-side confirmation (a pending 3DS or redirect step) is flagged, not
forced. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/paid-checkout-never-converts-to-order/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("complete_paid_checkouts")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
GRACE_MINUTES = float(os.environ.get("GRACE_MINUTES", "5"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PENDING_CHARGE_STATES = {"PENDING", "PARTIAL"}

CHECKOUTS_QUERY = """
query {
  checkouts(first: 50, filter: {authorizeStatus: [FULL]}) {
    edges {
      node {
        id
        token
        created
        channel { slug }
        totalPrice { gross { amount currency } }
        authorizeStatus
        chargeStatus
        transactions { id chargeStatus authorizeStatus }
      }
    }
  }
}"""

COMPLETE_MUTATION = """
mutation Complete($id: ID!) {
  checkoutComplete(id: $id) {
    order { id number }
    confirmationNeeded
    confirmationData
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


def _parse(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def should_complete_checkout(checkout, now_iso, grace_minutes=5):
    """Pure decision function. No network calls, fully unit-testable with a fixed clock.

    checkout: {authorizeStatus, chargeStatus, createdAt, hasOrder}
    Returns {"action": "complete"|"flag"|"skip", "reason": str}
    """
    if checkout.get("hasOrder"):
        return {"action": "skip", "reason": "already has an order"}
    if checkout.get("authorizeStatus") != "FULL":
        return {"action": "skip", "reason": "not fully authorized"}
    age_minutes = (_parse(now_iso) - _parse(checkout["createdAt"])).total_seconds() / 60
    if age_minutes < grace_minutes:
        return {"action": "skip", "reason": "too new, still likely mid-flow"}
    if checkout.get("chargeStatus") in PENDING_CHARGE_STATES:
        return {"action": "flag", "reason": "provider-side confirmation still pending"}
    return {"action": "complete", "reason": "paid, aged past grace period, no order yet"}


def paid_checkouts():
    data = gql(CHECKOUTS_QUERY)["checkouts"]
    for edge in data["edges"]:
        node = edge["node"]
        node["createdAt"] = node["created"]
        # A checkout that already converted is deleted and replaced by an Order,
        # so anything returned by this query has no Order yet.
        node["hasOrder"] = False
        yield node


def complete_checkout(checkout_id):
    result = gql(COMPLETE_MUTATION, {"id": checkout_id})["checkoutComplete"]
    if result["errors"]:
        return {"status": "unfixable", "errors": result["errors"]}
    if result["confirmationNeeded"]:
        return {"status": "needs_confirmation", "confirmationData": result["confirmationData"]}
    return {"status": "completed", "order": result["order"]}


def run():
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    completed = 0
    flagged = 0
    for checkout in paid_checkouts():
        decision = should_complete_checkout(checkout, now_iso, GRACE_MINUTES)
        if decision["action"] == "skip":
            continue
        if decision["action"] == "flag":
            log.warning("Checkout %s flagged: %s", checkout["token"], decision["reason"])
            flagged += 1
            continue
        log.info("Checkout %s eligible. %s", checkout["token"],
                  "would complete" if DRY_RUN else "completing")
        if not DRY_RUN:
            outcome = complete_checkout(checkout["id"])
            if outcome["status"] != "completed":
                log.warning("Checkout %s not completed: %s", checkout["token"], outcome)
                continue
        completed += 1
    log.info("Done. %d checkout(s) %s, %d flagged for review.",
              completed, "to complete" if DRY_RUN else "completed", flagged)


if __name__ == "__main__":
    run()
