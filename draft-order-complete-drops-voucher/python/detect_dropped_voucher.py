"""Detect Saleor draft orders whose voucher discount was dropped or shrunk by
draftOrderComplete's price recalculation, and report them for finance review.

Saleor recalculates an order's prices through its pricing manager at several
trigger points, including the transition draftOrderComplete performs. The
discount is re-derived from the order's stored voucher and voucherCode
reference every time that recalculation runs, and that path has historically
failed to consistently re-derive it, dropping the OrderDiscount linkage or
recomputing it against the wrong base.

There is no safe auto-fix: re-adding a discount after completion can desync
the order total from an already-captured Transaction or Payment. This is
detect and report, with an optional orderDiscountAdd call gated by DRY_RUN
and meant to run only after a human has reviewed the finding.

Guide: https://www.allanninal.dev/saleor/draft-order-complete-drops-voucher/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_dropped_voucher")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDER_SNAPSHOT_QUERY = """
query($id: ID!) {
  order(id: $id) {
    id
    status
    voucherCode
    voucher { code }
    discounts { type valueType value amount { amount } }
    total { gross { amount } }
    undiscountedTotal { gross { amount } }
  }
}"""

COMPLETE_MUTATION = """
mutation($id: ID!) {
  draftOrderComplete(id: $id) {
    order { id }
    errors { field message }
  }
}"""

DISCOUNT_ADD_MUTATION = """
mutation($orderId: ID!, $value: PositiveDecimal!, $reason: String!) {
  orderDiscountAdd(orderId: $orderId, input: { valueType: FIXED, value: $value, reason: $reason }) {
    order { id }
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


def fetch_order_snapshot(order_id):
    order = gql(ORDER_SNAPSHOT_QUERY, {"id": order_id})["order"]
    return {
        "voucherCode": order["voucherCode"],
        "totalGross": order["total"]["gross"]["amount"],
        "undiscountedTotalGross": order["undiscountedTotal"]["gross"]["amount"],
    }


def diff_voucher_discount(draft_snapshot, completed_snapshot, tolerance=0.01):
    """
    Pure decision logic, no I/O.
    draft_snapshot / completed_snapshot: {"voucherCode": str | None,
                                           "totalGross": float,
                                           "undiscountedTotalGross": float}
    Returns {"isDropped": bool, "expectedDiscount": float,
             "actualDiscount": float, "delta": float}
    """
    expected_discount = draft_snapshot["undiscountedTotalGross"] - draft_snapshot["totalGross"]
    actual_discount = completed_snapshot["undiscountedTotalGross"] - completed_snapshot["totalGross"]
    delta = expected_discount - actual_discount

    voucher_was_removed = bool(draft_snapshot["voucherCode"]) and not completed_snapshot["voucherCode"]
    discount_shrank = delta > tolerance

    is_dropped = (
        bool(draft_snapshot["voucherCode"])
        and expected_discount > tolerance
        and (voucher_was_removed or discount_shrank)
    )

    return {
        "isDropped": is_dropped,
        "expectedDiscount": expected_discount,
        "actualDiscount": actual_discount,
        "delta": delta,
    }


def complete_draft_order(draft_id):
    result = gql(COMPLETE_MUTATION, {"id": draft_id})["draftOrderComplete"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["order"]["id"]


def recover_discount(order_id, expected_discount):
    result = gql(
        DISCOUNT_ADD_MUTATION,
        {
            "orderId": order_id,
            "value": round(expected_discount, 2),
            "reason": "Recovered voucher discount from draft order snapshot",
        },
    )["orderDiscountAdd"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["order"]["id"]


def run(draft_order_ids):
    mode = "dry run" if DRY_RUN else "live"
    log.info("Checking %d draft order(s) for dropped vouchers (%s)", len(draft_order_ids), mode)

    flagged = 0
    for draft_id in draft_order_ids:
        draft_snapshot = fetch_order_snapshot(draft_id)
        completed_id = complete_draft_order(draft_id)
        completed_snapshot = fetch_order_snapshot(completed_id)

        result = diff_voucher_discount(draft_snapshot, completed_snapshot)
        if not result["isDropped"]:
            continue

        flagged += 1
        log.warning(
            "Voucher dropped on order=%s expected=%.2f actual=%.2f delta=%.2f",
            completed_id, result["expectedDiscount"], result["actualDiscount"], result["delta"],
        )

        if not DRY_RUN:
            recover_discount(completed_id, result["expectedDiscount"])

    log.info(
        "Done. %d order(s) with a dropped voucher %s.",
        flagged, "to review" if DRY_RUN else "had a discount re-added",
    )
    return flagged


if __name__ == "__main__":
    run([])
