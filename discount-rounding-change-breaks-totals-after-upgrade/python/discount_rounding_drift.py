"""Flag Saleor orders and open checkouts whose percentage-voucher discount
was computed under the pre-3.12 ROUND_DOWN rule and no longer matches what
the same voucher computes today under ROUND_HALF_UP.

Saleor 3.12 changed the decimal quantization mode used for percentage
discounts from ROUND_DOWN to ROUND_HALF_UP (see the 3.11 to 3.12 upgrade
guide). A 12.5% voucher on 13.00 gives a 1.62 discount and 11.38 total
under the old rule, versus 1.63 and 11.37 under the current one. Only
PERCENTAGE vouchers are affected; FIXED vouchers never need to quantize a
fraction. Saleor 3.12 also separately started populating Checkout.discount
for SPECIFIC_PRODUCT and apply-once-per-order vouchers, which is a benign,
unrelated change that a naive checkout.discount diff would also flag.

There is no safe auto-fix for a placed or paid order: it is a financial
record of what was actually charged, so it is reported for finance to
review, never rewritten. Only a still-open, unpaid checkout can be safely
nudged into recomputing its own total, by removing and reapplying the same
voucher code so Saleor's own current pricing logic recalculates it.

Guide: https://www.allanninal.dev/saleor/discount-rounding-change-breaks-totals-after-upgrade/
"""
import os
import logging
import requests
from decimal import Decimal, ROUND_HALF_UP

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("discount_rounding_drift")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
DEPLOY_DATE_ISO = os.environ.get("DEPLOY_DATE_ISO", "1970-01-01T00:00:00Z")

VOUCHERS_QUERY = """
query {
  vouchers(first: 100) {
    edges { node { id name discountValueType type codes(first: 1) { edges { node { code } } } } }
  }
}"""

ORDERS_QUERY = """
query($after: String) {
  orders(first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id number created
        voucher { id discountValueType type }
        undiscountedTotal { gross { amount currency } }
        total { gross { amount currency } }
        discounts { id value valueType amount { amount } }
      }
    }
  }
}"""

REMOVE_PROMO = """
mutation($checkoutId: ID!, $code: String!) {
  checkoutRemovePromoCode(id: $checkoutId, promoCode: $code) {
    errors { field message code }
  }
}"""

ADD_PROMO = """
mutation($checkoutId: ID!, $code: String!) {
  checkoutAddPromoCode(id: $checkoutId, promoCode: $code) {
    checkout { id discount { amount } totalPrice { gross { amount } } }
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


def compute_discount_drift(
    undiscounted_amount, discount_value_type, discount_value,
    persisted_discount_amount, currency_decimal_places=2,
):
    """
    Pure decision logic, no I/O.
    FIXED vouchers are rounding-mode-invariant, so they are never drifted.
    PERCENTAGE vouchers are recomputed with the current ROUND_HALF_UP rule
    and compared against whatever amount is already persisted.
    """
    if discount_value_type != "PERCENTAGE":
        return {"expected_discount_amount": persisted_discount_amount, "delta": 0.0, "is_drifted": False}

    quantum = Decimal(1).scaleb(-currency_decimal_places)
    raw = Decimal(str(undiscounted_amount)) * Decimal(str(discount_value)) / Decimal(100)
    expected = raw.quantize(quantum, rounding=ROUND_HALF_UP)

    delta = (expected - Decimal(str(persisted_discount_amount))).quantize(quantum, rounding=ROUND_HALF_UP)
    threshold = Decimal(1).scaleb(-currency_decimal_places)
    is_drifted = abs(delta) >= threshold

    return {
        "expected_discount_amount": float(expected),
        "delta": float(delta),
        "is_drifted": is_drifted,
    }


def percentage_voucher_ids():
    data = gql(VOUCHERS_QUERY)["vouchers"]
    return {
        edge["node"]["id"]
        for edge in data["edges"]
        if edge["node"]["discountValueType"] == "PERCENTAGE"
    }


def persisted_discount(order):
    amounts = [d["amount"]["amount"] for d in (order.get("discounts") or [])]
    if amounts:
        return sum(amounts)
    undiscounted = order["undiscountedTotal"]["gross"]["amount"]
    total = order["total"]["gross"]["amount"]
    return round(undiscounted - total, 2)


def flag_order(order, deploy_date_iso, discount_value):
    voucher = order.get("voucher")
    if not voucher:
        return None

    undiscounted = order["undiscountedTotal"]["gross"]["amount"]
    persisted = persisted_discount(order)

    result = compute_discount_drift(
        undiscounted_amount=undiscounted,
        discount_value_type=voucher["discountValueType"],
        discount_value=discount_value,
        persisted_discount_amount=persisted,
    )
    if not result["is_drifted"]:
        return None

    return {
        "order_id": order["id"],
        "order_number": order["number"],
        "created": order["created"],
        "predates_upgrade": order["created"] < deploy_date_iso,
        "persisted_discount": persisted,
        "expected_discount": result["expected_discount_amount"],
        "delta": result["delta"],
        "currency": order["total"]["gross"]["currency"],
    }


def orders_with_voucher():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"after": cursor})["orders"]
        for edge in data["edges"]:
            node = edge["node"]
            if node.get("voucher"):
                yield node
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def reapply_voucher(checkout_id, code):
    removed = gql(REMOVE_PROMO, {"checkoutId": checkout_id, "code": code})["checkoutRemovePromoCode"]
    if removed["errors"]:
        raise RuntimeError(removed["errors"])
    added = gql(ADD_PROMO, {"checkoutId": checkout_id, "code": code})["checkoutAddPromoCode"]
    if added["errors"]:
        raise RuntimeError(added["errors"])
    return added["checkout"]


def run():
    percentage_ids = percentage_voucher_ids()
    mode = "dry run" if DRY_RUN else "live"
    log.info("Scanning orders for discount rounding drift (%s)", mode)

    flagged = 0
    for order in orders_with_voucher():
        voucher = order["voucher"]
        if voucher["id"] not in percentage_ids:
            continue

        # In a real run, resolve discount_value from the voucher's channel listing.
        finding = flag_order(order, DEPLOY_DATE_ISO, discount_value=None)
        if finding is None:
            continue

        flagged += 1
        log.warning(
            "Drifted order=%s created=%s predates_upgrade=%s expected=%.2f persisted=%.2f delta=%.2f %s",
            finding["order_number"], finding["created"], finding["predates_upgrade"],
            finding["expected_discount"], finding["persisted_discount"], finding["delta"],
            finding["currency"],
        )

    log.info("Done. %d order(s) flagged for finance review. No order totals were rewritten.", flagged)
    return flagged


if __name__ == "__main__":
    run()
