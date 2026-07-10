"""Detect Saleor order lines whose manual discount silently disappears when
the order's prices recalculate (saleor/saleor#4675).

Draft and unconfirmed order prices are lazy: any mutation that touches the
order, adding a line, updating a line, changing the shipping address or
method, or applying a voucher, can trigger fetch_order_prices_if_expired,
which re-derives each line's unit price from the undiscounted price plus
whatever catalogue promotions and vouchers currently apply. A manual line
discount applied through orderLineDiscountUpdate is supposed to take
precedence over that, but if its flag was not carried through correctly,
the recalculation falls back to standard pricing and clears
unit_discount_value and unit_discount_reason without any error.

This script never blind-restores a discount. Under DRY_RUN=true (the
default) it only reports flagged order and line ids with their before and
after values. When DRY_RUN=false and a human has confirmed the loss is a
regression and not a legitimate price change, it re-applies the exact
captured discount with orderLineDiscountUpdate. Safe to run again and
again, since a line with no detected loss is never touched.

Guide: https://www.allanninal.dev/saleor/manual-line-discount-deleted-on-recalculation/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_discount_loss")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDER_LINES_QUERY = """
query($id: ID!) {
  order(id: $id) {
    id
    status
    lines {
      id
      productName
      unitDiscount { amount currency }
      unitDiscountType
      unitDiscountValue
      unitDiscountReason
      undiscountedUnitPrice { gross { amount } }
      unitPrice { gross { amount } }
      isPriceOverridden
    }
  }
}"""

RESTORE_DISCOUNT_MUTATION = """
mutation($lineId: ID!, $input: OrderDiscountCommonInput!) {
  orderLineDiscountUpdate(orderLineId: $lineId, input: $input) {
    orderLine { id unitDiscountValue unitDiscountReason }
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


def decide_discount_loss(before, after):
    """Pure decision function. Takes two plain snapshot objects and returns a
    decision record. No network or DB calls.

    before / after each have: unitDiscountValue (number), unitDiscountType
    ('FIXED'|'PERCENTAGE'), unitDiscountReason (str|None),
    unitPriceGrossAmount (number). after additionally carries
    undiscountedUnitPriceGrossAmount, which is accepted but not required by
    the decision itself (callers may use it for their own diagnostics).

    Returns {"lost": bool, "shouldFlag": bool, "restoreInput": dict|None}.
    lost is True when the line had a manual discount before (positive value
    or a non-null reason) and both the value and the reason are gone after.
    shouldFlag mirrors lost. restoreInput is populated only when lost is
    True, using the fields captured in `before`.
    """
    had_discount = before["unitDiscountValue"] > 0 or bool(before["unitDiscountReason"])
    lost_value = after["unitDiscountValue"] == 0
    lost_reason = not after["unitDiscountReason"]

    lost = had_discount and lost_value and lost_reason

    if not lost:
        return {"lost": False, "shouldFlag": False, "restoreInput": None}

    restore_input = {
        "valueType": before["unitDiscountType"],
        "value": before["unitDiscountValue"],
        "reason": before["unitDiscountReason"],
    }
    return {"lost": True, "shouldFlag": True, "restoreInput": restore_input}


def snapshot_order_lines(order_id):
    order = gql(ORDER_LINES_QUERY, {"id": order_id})["order"]
    return {
        line["id"]: {
            "productName": line["productName"],
            "unitDiscountType": line["unitDiscountType"],
            "unitDiscountValue": line["unitDiscountValue"] or 0,
            "unitDiscountReason": line["unitDiscountReason"],
            "unitPriceGrossAmount": line["unitPrice"]["gross"]["amount"],
            "undiscountedUnitPriceGrossAmount": line["undiscountedUnitPrice"]["gross"]["amount"],
        }
        for line in order["lines"]
    }


def flag_losses(order_id, before, after):
    flagged = []
    for line_id, before_line in before.items():
        after_line = after.get(line_id)
        if after_line is None:
            continue
        decision = decide_discount_loss(before_line, after_line)
        if decision["shouldFlag"]:
            flagged.append({
                "orderId": order_id,
                "lineId": line_id,
                "productName": before_line["productName"],
                "before": before_line,
                "after": after_line,
                "restoreInput": decision["restoreInput"],
            })
    return flagged


def restore_discount(line_id, restore_input):
    result = gql(RESTORE_DISCOUNT_MUTATION, {"lineId": line_id, "input": restore_input})["orderLineDiscountUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["orderLine"]


def run(order_id, mutate_fn):
    """mutate_fn is the caller-supplied function that performs the mutation
    suspected of triggering recalculation, for example orderLinesCreate or
    orderUpdate. It receives no arguments and its return value is ignored.
    """
    before = snapshot_order_lines(order_id)
    mutate_fn()
    after = snapshot_order_lines(order_id)

    flagged = flag_losses(order_id, before, after)

    for item in flagged:
        log.warning(
            "Order %s line %s (%s) lost its manual discount. before=%s after=%s",
            item["orderId"], item["lineId"], item["productName"],
            item["before"]["unitDiscountValue"], item["after"]["unitDiscountValue"],
        )
        if not DRY_RUN:
            restore_discount(item["lineId"], item["restoreInput"])
            log.info("Restored discount on line %s.", item["lineId"])

    log.info("Done. %d line(s) flagged for a lost manual discount.", len(flagged))
    return flagged


if __name__ == "__main__":
    run(order_id=os.environ.get("ORDER_ID", ""), mutate_fn=lambda: None)
