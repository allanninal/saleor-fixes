"""Find Saleor gift cards whose balance was overwritten by a giftCardUpdate
call that used balanceAmount to top up the remaining balance on a card
that had already been partially spent (see the GiftCard object docs and
the giftCardUpdate mutation docs).

balanceAmount on GiftCardUpdateInput is written to both initialBalance and
currentBalance in one go, with no server-side check for whether the card
had already been spent down. This script never writes a corrected balance.
Saleor keeps no separate ledger column, so the true remaining balance only
survives as the oldCurrentBalance snapshot on the GiftCardEvent just before
the faulty update. Under DRY_RUN=true (the default, and the only mode this
script supports out of the box) it logs a report entry for every affected
card: {id, displayCode, recoveredCurrentBalanceAmount, currentBalanceAmount,
initialBalanceAmount, reason}. Hand that report to staff for a confirmed
manual correction. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/gift-card-balance-update-overwrites-initial/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_gift_card_balances")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

GIFT_CARDS_QUERY = """
query($cursor: String) {
  giftCards(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        displayCode
        isActive
        initialBalance { amount currency }
        currentBalance { amount currency }
        created
        lastUsedOn
        events(first: 50) {
          edges {
            node {
              type
              date
              balance { initialBalance currentBalance oldInitialBalance oldCurrentBalance }
            }
          }
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


def classify_gift_card_balance_overwrite(card):
    """Pure decision function. Takes a plain card dict:
    {initialBalanceAmount, currentBalanceAmount, events: [
        {type, oldInitialBalanceAmount, oldCurrentBalanceAmount,
         newInitialBalanceAmount, newCurrentBalanceAmount}, ...
    ]}
    Returns {affected, reason, recoveredCurrentBalanceAmount}.
    """
    if card["currentBalanceAmount"] > card["initialBalanceAmount"]:
        return {"affected": True, "reason": "current_exceeds_initial", "recoveredCurrentBalanceAmount": None}

    for event in card["events"]:
        if event["type"] != "UPDATED":
            continue
        old_initial = event["oldInitialBalanceAmount"]
        old_current = event["oldCurrentBalanceAmount"]
        new_initial = event["newInitialBalanceAmount"]
        new_current = event["newCurrentBalanceAmount"]
        if old_initial is None or old_current is None:
            continue
        if old_current == old_initial:
            continue
        if new_initial is None or new_current is None or new_initial != new_current:
            continue
        return {"affected": True, "reason": "update_reset_spent_card", "recoveredCurrentBalanceAmount": old_current}

    return {"affected": False, "reason": None, "recoveredCurrentBalanceAmount": None}


def _to_plain_card(node):
    events = []
    for edge in node["events"]["edges"]:
        ev = edge["node"]
        bal = ev.get("balance") or {}
        events.append({
            "type": ev["type"],
            "oldInitialBalanceAmount": bal.get("oldInitialBalance"),
            "oldCurrentBalanceAmount": bal.get("oldCurrentBalance"),
            "newInitialBalanceAmount": bal.get("initialBalance"),
            "newCurrentBalanceAmount": bal.get("currentBalance"),
        })
    return {
        "id": node["id"],
        "displayCode": node["displayCode"],
        "initialBalanceAmount": node["initialBalance"]["amount"],
        "currentBalanceAmount": node["currentBalance"]["amount"],
        "events": events,
    }


def gift_cards():
    cursor = None
    while True:
        data = gql(GIFT_CARDS_QUERY, {"cursor": cursor})["giftCards"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def run():
    flagged = 0
    for node in gift_cards():
        card = _to_plain_card(node)
        result = classify_gift_card_balance_overwrite(card)
        if not result["affected"]:
            continue

        report_entry = {
            "id": card["id"],
            "displayCode": card["displayCode"],
            "recoveredCurrentBalanceAmount": result["recoveredCurrentBalanceAmount"],
            "currentBalanceAmount": card["currentBalanceAmount"],
            "initialBalanceAmount": card["initialBalanceAmount"],
            "reason": result["reason"],
        }
        log.warning("Overwritten gift card balance found. %s %s", report_entry,
                    "(dry run, reporting only)" if DRY_RUN else "(reporting only, confirm before any write)")
        flagged += 1

    log.info("Done. %d gift card(s) flagged for staff review.", flagged)


if __name__ == "__main__":
    run()
