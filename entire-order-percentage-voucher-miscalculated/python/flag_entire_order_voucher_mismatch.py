"""Flag Saleor orders where an ENTIRE_ORDER percentage voucher was calculated
against the wrong base amount, understating the discount when a line also
carried an active catalogue Promotion.

Saleor's docs say an ENTIRE_ORDER voucher discount applies to the subtotal,
the sum of line prices after any catalogue promotion has already reduced
them. In affected versions the order-discount pipeline instead sourced its
base amount from the undiscounted total, so the voucher percentage and the
promotion percentage stacked additively instead of compounding. Tracked as
Saleor GitHub issue #17453, which also reported non-deterministic totals on
otherwise-identical orders.

There is no safe auto-fix for a finalized order: Saleor has no mutation that
overwrites a stored total or discount directly, and orderUpdate does not
accept one. This is detect and report, run in DRY_RUN mode by default, for
finance and support to review before any correction is made by hand.

Guide: https://www.allanninal.dev/saleor/entire-order-percentage-voucher-miscalculated/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_entire_order_voucher_mismatch")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
TOLERANCE = 0.01

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        subtotal { gross { amount } }
        undiscountedTotal { gross { amount } }
        total { gross { amount } }
        channel { slug }
        voucher {
          id
          type
          discountValueType
          channelListings { channel { slug } discountValue }
        }
        discounts { type value valueType amount { amount } }
        lines {
          id
          unitDiscountAmount
          unitDiscountType
          undiscountedUnitPrice { gross { amount } }
        }
      }
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


def round2(value):
    return round(value + 1e-9, 2)


def compute_expected_entire_order_percentage_discount(
    subtotal_amount, voucher_discount_value, apply_once_per_order, cheapest_line_unit_price=None
):
    """
    Pure decision logic, no I/O.
    subtotal_amount MUST already reflect any catalogue-promotion line discounts,
    never the undiscounted total, per the documented ENTIRE_ORDER semantics.
    Returns the expected discount amount, capped at subtotal_amount.
    """
    if apply_once_per_order:
        base = cheapest_line_unit_price or 0.0
        discount = round2(base * (voucher_discount_value / 100))
    else:
        discount = round2(subtotal_amount * (voucher_discount_value / 100))
    return min(discount, subtotal_amount)


def actual_voucher_discount(order):
    voucher_amounts = [
        d["amount"]["amount"] for d in (order.get("discounts") or []) if d.get("type") == "VOUCHER"
    ]
    if voucher_amounts:
        return sum(voucher_amounts)
    undiscounted = order["undiscountedTotal"]["gross"]["amount"]
    total = order["total"]["gross"]["amount"]
    return round2(undiscounted - total)


def has_stacked_promotion_and_voucher(order):
    lines = order.get("lines") or []
    return any((line.get("unitDiscountAmount") or 0) > 0 for line in lines)


def flag_order(order, apply_once_per_order=False, cheapest_line_unit_price=None):
    channel_slug = order["channel"]["slug"]
    listing = next(
        (c for c in order["voucher"]["channelListings"] if c["channel"]["slug"] == channel_slug),
        None,
    )
    if listing is None:
        return None

    subtotal = order["subtotal"]["gross"]["amount"]
    expected = compute_expected_entire_order_percentage_discount(
        subtotal, listing["discountValue"], apply_once_per_order, cheapest_line_unit_price
    )
    actual = actual_voucher_discount(order)
    delta = round2(actual - expected)

    if abs(delta) <= TOLERANCE:
        return None

    return {
        "order_id": order["id"],
        "order_number": order["number"],
        "expected_discount": expected,
        "actual_discount": actual,
        "delta": delta,
        "channel": channel_slug,
        "voucher_code": order["voucher"]["id"],
        "stacked_with_promotion": has_stacked_promotion_and_voucher(order),
    }


def entire_order_voucher_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            node = edge["node"]
            voucher = node.get("voucher")
            if (
                voucher
                and voucher.get("type") == "ENTIRE_ORDER"
                and voucher.get("discountValueType") == "PERCENTAGE"
            ):
                yield node
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def run():
    mode = "dry run" if DRY_RUN else "live"
    log.info("Scanning orders for entire order percentage voucher mismatches (%s)", mode)

    flagged = 0
    for order in entire_order_voucher_orders():
        finding = flag_order(order)
        if finding is None:
            continue

        flagged += 1
        log.warning(
            "Mismatch on order=%s expected=%.2f actual=%.2f delta=%.2f channel=%s stacked=%s",
            finding["order_number"], finding["expected_discount"], finding["actual_discount"],
            finding["delta"], finding["channel"], finding["stacked_with_promotion"],
        )

    log.info("Done. %d order(s) flagged for finance review.", flagged)
    return flagged


if __name__ == "__main__":
    run()
