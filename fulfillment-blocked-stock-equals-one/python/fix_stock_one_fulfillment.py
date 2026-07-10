"""Detect and repair Saleor orders blocked from fulfillment by the
quantity-equals-one stock allocation boundary case.

Saleor allocates stock at order placement, not at fulfillment time. A variant
whose warehouse Stock.quantity is exactly one becomes fully allocated to its
own order the moment that order is placed. When orderFulfill later re-checks
availability as quantity - quantityAllocated, it reads zero and rejects the
fulfillment with INSUFFICIENT_STOCK, even though the unit is reserved for
this exact order.

This script only retries orderFulfill with allowStockToBeExceeded=true when
the pure decision function AND a dry-run orderFulfill call both confirm the
boundary case. Otherwise it reports the SKU for a human to reconcile. Safe
to run again and again.

Guide: https://www.allanninal.dev/saleor/fulfillment-blocked-stock-equals-one/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_stock_one_fulfillment")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDER_QUERY = """
query($orderId: ID!) {
  order(id: $orderId) {
    id
    status
    lines {
      id
      quantity
      quantityFulfilled
      variant {
        id
        name
        stocks {
          warehouse { id name }
          quantity
          quantityAllocated
        }
      }
    }
  }
}"""

FULFILL_MUTATION = """
mutation($orderId: ID!, $lines: [OrderFulfillLineInput!]!, $allowExceed: Boolean!) {
  orderFulfill(
    order: $orderId,
    input: { linesInput: $lines, allowStockToBeExceeded: $allowExceed }
  ) {
    fulfillments { id status }
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


def decide_fulfillment_allowed(stock, requested_qty, already_allocated_for_this_order):
    """
    Pure decision logic, no I/O.
    stock: {"quantity": int, "quantityAllocated": int}
    requested_qty: int, the amount this order line still needs fulfilled
    already_allocated_for_this_order: int, this order's own hold on this stock row
    Returns {"allowed": bool, "reason": str}.
    """
    true_available = stock["quantity"] - (stock["quantityAllocated"] - already_allocated_for_this_order)

    if requested_qty <= true_available:
        if stock["quantity"] == 1 and already_allocated_for_this_order >= stock["quantityAllocated"]:
            return {
                "allowed": True,
                "reason": "BOUNDARY_CASE: quantity=1 fully allocated to this order, fulfillment should proceed",
            }
        return {"allowed": True, "reason": "OK"}

    return {
        "allowed": False,
        "reason": f"INSUFFICIENT_STOCK: only {true_available} of {requested_qty} requested available",
    }


def get_order(order_id):
    return gql(ORDER_QUERY, {"orderId": order_id})["order"]


def attempt_fulfill(order_id, lines_input, allow_exceed):
    result = gql(
        FULFILL_MUTATION,
        {"orderId": order_id, "lines": lines_input, "allowExceed": allow_exceed},
    )["orderFulfill"]
    return result


def _line_input(line_id, warehouse_id, qty):
    return {"orderLineId": line_id, "stocks": [{"warehouse": warehouse_id, "quantity": qty}]}


def check_and_repair(order_id):
    order = get_order(order_id)
    flagged = []
    repaired = []

    for line in order["lines"]:
        requested = line["quantity"] - line["quantityFulfilled"]
        if requested <= 0:
            continue

        variant = line["variant"]
        for stock in variant["stocks"]:
            if stock["quantity"] != 1:
                continue

            # This order's own hold on a quantity=1 row is, at most, the
            # requested amount, since nothing else can share a single unit.
            already_allocated = min(requested, stock["quantityAllocated"])
            decision = decide_fulfillment_allowed(
                {"quantity": stock["quantity"], "quantityAllocated": stock["quantityAllocated"]},
                requested,
                already_allocated,
            )

            if not decision["allowed"]:
                log.warning(
                    "Order %s line %s: %s. Reporting for manual reconciliation.",
                    order_id, line["id"], decision["reason"],
                )
                flagged.append({"line_id": line["id"], "reason": decision["reason"]})
                continue

            if "BOUNDARY_CASE" not in decision["reason"]:
                continue

            warehouse_id = stock["warehouse"]["id"]
            lines_input = [_line_input(line["id"], warehouse_id, requested)]

            dry_result = attempt_fulfill(order_id, lines_input, allow_exceed=False)
            codes = [e["code"] for e in dry_result.get("errors", [])]

            if "INSUFFICIENT_STOCK" not in codes:
                log.info("Order %s line %s: no error on dry check, nothing to repair.", order_id, line["id"])
                continue

            log.warning(
                "Order %s line %s confirmed boundary case (quantity=1, fully self-allocated). %s",
                order_id, line["id"], "Would retry with allowStockToBeExceeded=true" if DRY_RUN else "Retrying now",
            )

            if not DRY_RUN:
                real_result = attempt_fulfill(order_id, lines_input, allow_exceed=True)
                if real_result.get("errors"):
                    raise RuntimeError(real_result["errors"])
                repaired.append({"line_id": line["id"], "fulfillments": real_result["fulfillments"]})

    log.info(
        "Done. %d line(s) flagged for manual review, %d line(s) %s.",
        len(flagged), len(repaired), "would be repaired" if DRY_RUN else "repaired",
    )
    return {"flagged": flagged, "repaired": repaired}


def run():
    order_id = os.environ["SALEOR_ORDER_ID"]
    check_and_repair(order_id)


if __name__ == "__main__":
    run()
