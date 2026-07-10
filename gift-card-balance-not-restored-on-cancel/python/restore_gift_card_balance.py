"""Restore a Saleor gift card's balance after the order it paid for was
cancelled, since orderCancel releases stock and marks the order CANCELED but
never runs compensating logic against GiftCard.currentBalance (see the
Saleor gift cards docs and saleor/saleor#9654, #11257).

Debiting a gift card happens inside payment processing (a GiftCardEvent of
type USED_IN_ORDER), which is decoupled from order status transitions, so
cancellation never fires a signal to reverse it. This script finds cancelled
orders that used a gift card, cross-references each card's event history for
an un-reversed USED_IN_ORDER debit, and restores the balance with
giftCardUpdate, capped at the card's own initial balance.

Under DRY_RUN=true (the default) it only prints the planned
{giftCardId, from, to, orderId} rows and never writes. Safe to run again and
again, since alreadyRestored and the initial-balance cap prevent double
restoration.

Guide: https://www.allanninal.dev/saleor/gift-card-balance-not-restored-on-cancel/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_gift_card_balance")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ROUNDING_EPSILON = 0.01

CANCELLED_GIFT_CARD_ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor, filter: { status: [CANCELED], giftCardUsed: true }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        giftCards {
          id
          currentBalance { amount currency }
          initialBalance { amount currency }
        }
      }
    }
  }
}"""

GIFT_CARD_EVENTS_QUERY = """
query($id: ID!) {
  giftCard(id: $id) {
    id
    currentBalance { amount currency }
    initialBalance { amount currency }
    events {
      type
      orderId
      balance { initialBalance currentBalance }
    }
  }
}"""

GIFT_CARD_UPDATE = """
mutation($id: ID!, $amount: Decimal!, $currency: String!) {
  giftCardUpdate(id: $id, input: { balanceAmount: { amount: $amount, currency: $currency } }) {
    giftCard { id currentBalance { amount currency } }
    errors { field code message }
  }
}"""

GIFT_CARD_BALANCE_QUERY = """
query($id: ID!) {
  giftCard(id: $id) { id currentBalance { amount currency } }
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


def plan_gift_card_restoration(order, gift_card_usages):
    """Pure decision logic, no I/O. Returns the restorations to make for one order.

    order: {id: str, status: str}
    gift_card_usages: list of {
        giftCardId: str,
        currentBalanceAmount: float,
        initialBalanceAmount: float,
        usedInOrderId: str,
        amountUsed: float,
        alreadyRestored: bool,
    }
    Returns list of {giftCardId, restoreToAmount, reason}.
    """
    if order.get("status") != "CANCELED":
        return []

    plans = []
    for usage in gift_card_usages:
        if usage["usedInOrderId"] != order["id"]:
            continue
        if usage["alreadyRestored"]:
            continue
        if usage["amountUsed"] <= 0:
            continue

        restore_to_amount = usage["currentBalanceAmount"] + usage["amountUsed"]
        overshoot = restore_to_amount - usage["initialBalanceAmount"]
        if overshoot > ROUNDING_EPSILON:
            continue  # anomaly: would exceed initial balance, do not clamp silently

        restore_to_amount = min(restore_to_amount, usage["initialBalanceAmount"])
        plans.append({
            "giftCardId": usage["giftCardId"],
            "restoreToAmount": restore_to_amount,
            "reason": "order_cancelled_gift_card_not_refunded",
        })

    return plans


def build_gift_card_usage(order_id, gift_card_id):
    card = gql(GIFT_CARD_EVENTS_QUERY, {"id": gift_card_id})["giftCard"]
    events = card["events"] or []

    used_events = [e for e in events if e["type"] == "USED_IN_ORDER" and e["orderId"] == order_id]
    if not used_events:
        return None

    used_event = used_events[0]
    amount_used = used_event["balance"]["initialBalance"] - used_event["balance"]["currentBalance"]
    already_restored = any(
        e["type"] != "USED_IN_ORDER" and e["orderId"] == order_id for e in events
    )

    return {
        "giftCardId": card["id"],
        "currentBalanceAmount": card["currentBalance"]["amount"],
        "initialBalanceAmount": card["initialBalance"]["amount"],
        "usedInOrderId": order_id,
        "amountUsed": amount_used,
        "alreadyRestored": already_restored,
        "currency": card["currentBalance"]["currency"],
    }


def cancelled_gift_card_orders():
    cursor = None
    while True:
        data = gql(CANCELLED_GIFT_CARD_ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def restore_gift_card_balance(gift_card_id, restore_to_amount, currency):
    # Re-fetch immediately before writing to avoid a lost update if the card
    # was used on another order in the interim.
    fresh = gql(GIFT_CARD_BALANCE_QUERY, {"id": gift_card_id})["giftCard"]

    result = gql(
        GIFT_CARD_UPDATE,
        {"id": gift_card_id, "amount": restore_to_amount, "currency": currency},
    )["giftCardUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])

    verify = gql(GIFT_CARD_BALANCE_QUERY, {"id": gift_card_id})["giftCard"]
    return {"before": fresh["currentBalance"]["amount"], "after": verify["currentBalance"]["amount"]}


def run():
    restored = 0
    for order in cancelled_gift_card_orders():
        usages = []
        for card in order.get("giftCards") or []:
            usage = build_gift_card_usage(order["id"], card["id"])
            if usage:
                usages.append(usage)

        plans = plan_gift_card_restoration(order, usages)
        for plan in plans:
            usage = next(u for u in usages if u["giftCardId"] == plan["giftCardId"])
            log.info(
                "Order %s gift card %s: %s from %.2f to %.2f",
                order["number"], plan["giftCardId"],
                "would restore" if DRY_RUN else "restoring",
                usage["currentBalanceAmount"], plan["restoreToAmount"],
            )
            if not DRY_RUN:
                restore_gift_card_balance(plan["giftCardId"], plan["restoreToAmount"], usage["currency"])
            restored += 1

    log.info("Done. %d gift card(s) %s.", restored, "to restore" if DRY_RUN else "restored")


if __name__ == "__main__":
    run()
