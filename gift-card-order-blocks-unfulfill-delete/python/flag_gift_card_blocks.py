"""Flag Saleor orders that cannot be unfulfilled or have a line deleted because
they contain a gift card line, because fulfilling that line already issued a
live, spendable GiftCard record that Saleor cannot safely claw back
(see saleor/saleor#9654, the OrderErrorCode enum, and the gift cards docs).

Saleor deliberately has no override mutation for CANNOT_CANCEL_FULFILLMENT,
NON_REMOVABLE_GIFT_LINE, or NON_EDITABLE_GIFT_LINE, so this script never calls
orderFulfillmentCancel, orderLineDelete, orderLineUpdate, or orderDelete
against a gift-card-line order. Under DRY_RUN=true (the default) it only logs
a report entry for each blocked order. The guarded remediation path
(deactivate_gift_card, add_reconciliation_note) is opt-in only, meant to run
after a human has confirmed the refund side out of band, and should only ever
run with DRY_RUN=false. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/gift-card-order-blocks-unfulfill-delete/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_gift_card_blocks")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FULFILLMENT_BLOCKING_STATUSES = {"FULFILLED", "PARTIALLY_FULFILLED", "WAITING_FOR_APPROVAL"}

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        isPaid
        giftCards { id last4CodeChars }
        lines { id isGift quantity }
        fulfillments { id status }
      }
    }
  }
}"""

# Guarded remediation only. Never calls orderFulfillmentCancel, orderLineDelete,
# or orderDelete against a gift-card-line order. Deactivate, then refund
# out of band, then leave a note.
GIFT_CARD_DEACTIVATE = """
mutation($id: ID!) {
  giftCardDeactivate(id: $id) {
    giftCard { id isActive }
    errors { field code message }
  }
}"""

ORDER_NOTE_ADD = """
mutation($order: ID!, $input: OrderNoteInput!) {
  orderNoteAdd(order: $order, input: $input) {
    event { id }
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


def classify_gift_card_order_block(order):
    """Pure decision logic, no I/O. Mirrors Saleor's own mutation checks:
    FulfillmentCancel.validate_order() calling order_has_gift_card_lines(order),
    and OrderLineDelete / OrderLineUpdate checking line.isGift.
    """
    gift_cards = order.get("giftCards") or []
    lines = order.get("lines") or []
    fulfillments = order.get("fulfillments") or []

    has_blocking_fulfillment = any(
        f.get("status") in FULFILLMENT_BLOCKING_STATUSES for f in fulfillments
    )
    if gift_cards and has_blocking_fulfillment:
        return {
            "blocked": True,
            "blockingCode": "CANNOT_CANCEL_FULFILLMENT",
            "reason": "Order has gift card lines and a fulfillment that cannot be cancelled.",
        }

    if any(line.get("isGift") for line in lines):
        return {
            "blocked": True,
            "blockingCode": "NON_REMOVABLE_GIFT_LINE",
            "reason": "Order has a gift card line that cannot be deleted.",
        }

    return {"blocked": False, "blockingCode": None, "reason": "No gift card lifecycle block found."}


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def deactivate_gift_card(gift_card_id):
    """Opt-in only. Never called by run(). Wire in yourself once a human has
    confirmed the refund side is handled out of band."""
    result = gql(GIFT_CARD_DEACTIVATE, {"id": gift_card_id})["giftCardDeactivate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["giftCard"]


def add_reconciliation_note(order_id, message):
    """Opt-in only. Never called by run()."""
    result = gql(ORDER_NOTE_ADD, {"order": order_id, "input": {"message": message}})["orderNoteAdd"]
    if result["errors"]:
        raise RuntimeError(result["errors"])


def run():
    flagged = 0
    for order in all_orders():
        decision = classify_gift_card_order_block(order)
        if not decision["blocked"]:
            continue

        report_entry = {
            "orderId": order["id"],
            "number": order["number"],
            "blockingCode": decision["blockingCode"],
        }
        log.warning("Blocked gift card order found. %s %s", report_entry,
                    "(dry run, reporting only)" if DRY_RUN else "(reporting only)")
        flagged += 1

    log.info("Done. %d blocked order(s) flagged for manual review.", flagged)


if __name__ == "__main__":
    run()
