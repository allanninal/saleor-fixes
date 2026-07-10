"""Release Saleor stock reservations left behind by abandoned checkouts.

Saleor's optional stock reservation feature allocates warehouse stock to a
checkout the moment items are added, and that reservation is only cleared by
a periodic Celery beat task. If that task queue is misconfigured, delayed, or
the worker is down, expired reservation rows are never deleted, so
Stock.quantity stays debited by phantom holds from carts nobody will finish.

This script lists checkouts, flags the ones whose stockReservationExpires is
already in the past or whose lastChange is older than
CHECKOUT_TTL_BEFORE_RELEASING_FUNDS (default 6h), and calls checkoutLinesDelete
to strip the lines from the flagged checkout. That is the documented,
non-destructive way to force Saleor to drop the associated stock reservation
without deleting the checkout or touching any order or payment record.

Never mutates Stock.quantity or allocations directly. Run on a schedule.
Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/abandoned-checkout-stock-not-released/
"""
import os
import logging
import requests
from datetime import datetime, timezone, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("release_stale_reservations")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
TTL_MINUTES = float(os.environ.get("TTL_MINUTES", "360"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CHECKOUTS_QUERY = """
query($cursor: String) {
  checkouts(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        token
        lastChange
        stockReservationExpires
        lines { id quantity variant { id sku } }
      }
    }
  }
}"""

LINES_DELETE = """
mutation($id: ID!, $linesIds: [ID!]!) {
  checkoutLinesDelete(id: $id, linesIds: $linesIds) {
    checkout { id stockReservationExpires }
    errors { field message }
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


def find_stale_reserved_checkouts(checkouts, now, ttl_minutes):
    """Pure decision function. No network or DB calls.

    checkouts: list of {id, token, lastChange, stockReservationExpires, lines: [{id, quantity, variantSku}]}
    now: a datetime (timezone aware) to compare against
    ttl_minutes: the TTL window in minutes (CHECKOUT_TTL_BEFORE_RELEASING_FUNDS)

    Returns one entry per stale checkout: {id, lineIds, reason}
    reason is "expired_reservation" when stockReservationExpires has passed,
    or "past_ttl" when lastChange is older than the TTL window and no
    reservation expiry is set. Checkouts with stockReservationExpires is None
    and lastChange within the TTL window are skipped.
    """
    stale = []
    for checkout in checkouts:
        expires = checkout.get("stockReservationExpires")
        if expires is not None:
            expires_at = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            if expires_at <= now:
                stale.append({
                    "id": checkout["id"],
                    "lineIds": [line["id"] for line in checkout["lines"]],
                    "reason": "expired_reservation",
                })
                continue
        last_change = checkout.get("lastChange")
        if last_change is None:
            continue
        changed_at = datetime.fromisoformat(last_change.replace("Z", "+00:00"))
        if changed_at <= now - timedelta(minutes=ttl_minutes):
            stale.append({
                "id": checkout["id"],
                "lineIds": [line["id"] for line in checkout["lines"]],
                "reason": "past_ttl",
            })
    return stale


def all_checkouts():
    cursor = None
    while True:
        data = gql(CHECKOUTS_QUERY, {"cursor": cursor})["checkouts"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def release_reservation(checkout_id, line_ids):
    result = gql(LINES_DELETE, {"id": checkout_id, "linesIds": line_ids})["checkoutLinesDelete"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["checkout"]


def run():
    now = datetime.now(timezone.utc)
    checkouts = list(all_checkouts())
    flagged = find_stale_reserved_checkouts(checkouts, now, TTL_MINUTES)
    released = 0
    for entry in flagged:
        log.warning(
            "Checkout %s stale (%s), %d line(s). %s",
            entry["id"], entry["reason"], len(entry["lineIds"]),
            "would release" if DRY_RUN else "releasing",
        )
        if not DRY_RUN:
            checkout = release_reservation(entry["id"], entry["lineIds"])
            log.info(
                "Checkout %s stockReservationExpires now %s",
                checkout["id"], checkout["stockReservationExpires"],
            )
        released += 1
    log.info("Done. %d stale checkout(s) %s.", released, "to release" if DRY_RUN else "released")


if __name__ == "__main__":
    run()
