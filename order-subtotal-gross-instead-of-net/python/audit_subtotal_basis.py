"""Flag Saleor orders where a downstream consumer recorded the wrong
subtotal basis, gross instead of net, or the reverse.

Order.subtotal, Order.total, and every OrderLine.unitPrice and totalPrice
resolve to a TaxedMoney object that always carries both a gross and a net
amount together, computed per line from the channel's TaxConfiguration
(pricesEnteredWithTax, displayGrossPrices, chargeTaxes) or a custom
ORDER_CALCULATE_TAXES tax app webhook. The bug is not in Saleor's stored
data, both figures it returns are correct, it is in a script, report, or
migration that read subtotal.gross.amount as the only subtotal while the
channel's pricesEnteredWithTax convention and the downstream ledger expect
net (or the reverse). Because each line can carry its own tax rate, the
discrepancy equals the sum of per-line tax, not a fixed percentage.

Under DRY_RUN=true (the default) this script only reports flagged orders,
it never writes anything. There is nothing to repair inside Saleor itself,
so the only ever corrective action is to regenerate a downstream export
after a human confirms which figure is contractually correct. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/order-subtotal-gross-instead-of-net/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_subtotal_basis")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
SUBTOTAL_EPSILON = float(os.environ.get("SUBTOTAL_EPSILON", "0.01"))

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        channel { id slug taxConfiguration { pricesEnteredWithTax displayGrossPrices chargeTaxes } }
        subtotal { gross { amount currency } net { amount currency } tax { amount } }
        lines {
          id
          quantity
          unitPrice { gross { amount } net { amount } }
          totalPrice { gross { amount } net { amount } }
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


def decide_subtotal_mismatch(order, tax_config, recorded_subtotal, epsilon=0.01):
    """Pure decision function. No I/O.

    order: {"subtotalNet": float, "subtotalGross": float,
            "lines": [{"totalPriceNet": float, "totalPriceGross": float}, ...]}
    tax_config: {"pricesEnteredWithTax": bool}
    recorded_subtotal: float, the figure a downstream consumer recorded for this order.

    Returns {"isMismatch": bool, "expected": float, "recorded": float,
             "delta": float, "expectedBasis": "net" | "gross"}.
    """
    expected_basis = "net" if tax_config.get("pricesEnteredWithTax") else "gross"
    key = "totalPriceNet" if expected_basis == "net" else "totalPriceGross"
    expected = sum(line[key] for line in order["lines"])
    delta = abs(expected - recorded_subtotal)
    is_mismatch = delta > epsilon

    return {
        "isMismatch": is_mismatch,
        "expected": expected,
        "recorded": recorded_subtotal,
        "delta": delta,
        "expectedBasis": expected_basis,
    }


def to_plain_order(node):
    lines = [
        {
            "totalPriceNet": line["totalPrice"]["net"]["amount"],
            "totalPriceGross": line["totalPrice"]["gross"]["amount"],
        }
        for line in node["lines"]
    ]
    return {
        "id": node["id"],
        "number": node["number"],
        "channelSlug": node["channel"]["slug"],
        "taxConfig": node["channel"]["taxConfiguration"],
        "subtotalNet": node["subtotal"]["net"]["amount"],
        "subtotalGross": node["subtotal"]["gross"]["amount"],
        "lines": lines,
    }


def build_report_row(order, recorded_subtotal):
    decision = decide_subtotal_mismatch(order, order["taxConfig"], recorded_subtotal, SUBTOTAL_EPSILON)
    if not decision["isMismatch"]:
        return None
    return {
        "orderId": order["id"],
        "orderNumber": order["number"],
        "channelSlug": order["channelSlug"],
        "pricesEnteredWithTax": order["taxConfig"].get("pricesEnteredWithTax"),
        "subtotalNet": order["subtotalNet"],
        "subtotalGross": order["subtotalGross"],
        "recordedSubtotal": recorded_subtotal,
        "expectedBasis": decision["expectedBasis"],
        "delta": round(decision["delta"], 2),
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


def recorded_subtotal_for(order):
    """Stand-in for however your own pipeline recorded a subtotal downstream,
    for example a prior CSV export, an ERP sync log, or a cached report row.
    Wire this up to your real source. Left here it mirrors gross, which is
    exactly the class of bug this script is built to catch."""
    return order["subtotalGross"]


def run():
    flagged = 0

    for node in all_orders():
        order = to_plain_order(node)
        recorded = recorded_subtotal_for(order)
        row = build_report_row(order, recorded)
        if row is None:
            continue

        log.warning("Subtotal basis mismatch found. %s", row)
        flagged += 1

    log.info("Done. %d order(s) flagged for review.%s", flagged,
              " (dry run)" if DRY_RUN else "")


if __name__ == "__main__":
    run()
