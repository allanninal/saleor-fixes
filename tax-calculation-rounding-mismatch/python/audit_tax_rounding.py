"""Audit Saleor orders for tax calculation mismatches, using Saleor's own
per-line rounding rule rather than a naive rate times subtotal recomputation.

With the flat-rate tax strategy, Saleor rounds tax to the cent on each order
line independently, then sums those already-rounded line amounts, plus
shipping, into order.total and order.subtotal. It never sums exact unrounded
values first and rounds once at the end. Because line.unitPrice is derived
by dividing the rounded line.totalPrice by quantity, high quantity, low
unit price lines amplify the per-unit rounding remainder, so the sum of
correctly rounded lines can legitimately differ from rate times subtotal by
one or more cents. This is documented, longstanding behavior (see
saleor/saleor#6720), not a bug, so this script never flags ordinary
per-line rounding drift.

Under DRY_RUN=true (the default) this script only reports flagged orders,
it never writes anything. A real aggregation bug looks different: the sum
of a line's own already-rounded tax plus shipping tax disagreeing with
order.total.tax, which points at cache or denormalization drift. Even
then, the safe corrective action is a gated no-op line update to force
Saleor's own recompute pipeline, limited to small confirmed deltas, never
a direct write to order totals. Run on a schedule. Safe to run again and
again.

Guide: https://www.allanninal.dev/saleor/tax-calculation-rounding-mismatch/
"""
import os
import logging
import requests
from decimal import Decimal, ROUND_HALF_UP

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_tax_rounding")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AGGREGATION_FIX_THRESHOLD_CENTS = float(os.environ.get("AGGREGATION_FIX_THRESHOLD_CENTS", "5"))

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        total { tax { amount } net { amount } gross { amount } }
        subtotal { net { amount } gross { amount } }
        shippingPrice { tax { amount } net { amount } gross { amount } }
        lines {
          id
          quantity
          unitPrice { tax { amount } net { amount } gross { amount } }
          totalPrice { tax { amount } net { amount } gross { amount } }
          taxRate
        }
      }
    }
  }
}"""

# A no-op line update (same quantity) forces Saleor's TaxedMoney recalculation
# pipeline to run again, without writing any amount directly.
FORCE_RECALC_MUTATION = """
mutation($orderId: ID!, $lineId: ID!, $quantity: Int!) {
  orderLineUpdate(id: $lineId, input: { quantity: $quantity }) {
    orderLine { id }
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


def check_line_tax(total_net_amount, tax_rate, actual_tax_amount,
                    currency_exponent=2, tolerance_cents=1):
    """Pure decision function. No I/O.

    Recomputes expected tax the way Saleor computes it for a single order
    line (net total times tax rate, rounded to the currency's minor unit
    with ROUND_HALF_UP), then compares to the actual tax amount with a
    tolerance sized in cents. Returns (is_mismatch, expected_tax, delta).
    """
    quantum = Decimal(10) ** -currency_exponent
    expected_tax = (Decimal(str(total_net_amount)) * Decimal(str(tax_rate))).quantize(
        quantum, rounding=ROUND_HALF_UP
    )
    delta = abs(Decimal(str(actual_tax_amount)) - expected_tax)
    is_mismatch = delta > quantum * tolerance_cents
    return is_mismatch, expected_tax, delta


def reconcile_order(order):
    """Pure function. Reconciles one order's lines and aggregate tax.

    Flags a line only when it drifts from Saleor's own rounding rule by
    more than a tolerance sized for how many lines the order has (this
    accounts for the legitimate compounding of per-line rounding).
    Separately checks whether order.total.tax equals the sum of every
    line's own already-rounded tax plus shipping tax; a disagreement there
    is a real aggregation bug, not rounding drift.
    """
    line_mismatches = []
    for line in order["lines"]:
        total_net = line["totalPrice"]["net"]["amount"]
        actual_tax = line["totalPrice"]["tax"]["amount"]
        is_mismatch, expected_tax, delta = check_line_tax(
            total_net, line["taxRate"], actual_tax,
            tolerance_cents=max(1, len(order["lines"])),
        )
        if is_mismatch:
            line_mismatches.append({
                "lineId": line["id"], "actual": actual_tax,
                "expected": float(expected_tax), "delta": float(delta),
            })

    expected_order_tax = sum(l["totalPrice"]["tax"]["amount"] for l in order["lines"])
    expected_order_tax += order["shippingPrice"]["tax"]["amount"]
    actual_order_tax = order["total"]["tax"]["amount"]
    aggregation_delta = round(abs(actual_order_tax - expected_order_tax), 2)
    aggregation_bug = aggregation_delta > 0.0

    return {
        "orderId": order["id"],
        "orderNumber": order["number"],
        "lineMismatches": line_mismatches,
        "aggregationBug": aggregation_bug,
        "aggregationDelta": aggregation_delta,
        "actualOrderTax": actual_order_tax,
        "expectedOrderTax": round(expected_order_tax, 2),
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


def force_recalculate(order_id, line_id, quantity):
    result = gql(FORCE_RECALC_MUTATION, {
        "orderId": order_id, "lineId": line_id, "quantity": quantity,
    })["orderLineUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])


def run():
    flagged = 0
    fixed = 0

    for order in all_orders():
        result = reconcile_order(order)
        if not result["lineMismatches"] and not result["aggregationBug"]:
            continue

        log.warning("Tax reconciliation flagged order %s: %s", order["number"], result)
        flagged += 1

        # Only a confirmed aggregation bug below the threshold is ever a
        # candidate for a gated, forced recompute. Line-level rounding drift
        # is expected arithmetic and is never auto-corrected.
        if (
            not DRY_RUN
            and result["aggregationBug"]
            and result["aggregationDelta"] <= AGGREGATION_FIX_THRESHOLD_CENTS / 100
            and order["lines"]
        ):
            first_line = order["lines"][0]
            log.info(
                "Forcing recompute on order %s via no-op line update (delta %.2f).",
                order["number"], result["aggregationDelta"],
            )
            force_recalculate(order["id"], first_line["id"], first_line["quantity"])
            fixed += 1
        elif result["aggregationBug"]:
            log.error(
                "Order %s aggregation delta %.2f exceeds threshold. Escalating to manual finance review.",
                order["number"], result["aggregationDelta"],
            )

    log.info("Done. %d order(s) flagged, %d recompute(s) triggered.", flagged, fixed)


if __name__ == "__main__":
    run()
