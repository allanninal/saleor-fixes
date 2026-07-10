"""Find Saleor webhooks and orders where a metadata write on an Order was
never seen because the app only subscribed to ORDER_UPDATED.

updateMetadata and updatePrivateMetadata only mark metadata fields dirty.
Saleor's webhook dispatch logic checks for substantive order-field changes
before firing ORDER_UPDATED, and a metadata-only write never satisfies that
check (saleor/saleor#10166). Saleor fires a separate ORDER_METADATA_UPDATED
event for exactly this case instead, so an app subscribed only to
ORDER_UPDATED never learns the order changed.

This script never re-fires a webhook, Saleor exposes no such mutation. Under
DRY_RUN=true (the default) it only reports misconfigured subscriptions and
order-level delivery gaps. When DRY_RUN=false it repairs the subscription
itself with webhookUpdate and re-verifies with a follow-up eventDeliveries
read. Order-level gaps stay report-only for manual reconciliation. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/order-updated-webhook-skipped-on-metadata-change/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_metadata_webhook_gap")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

WEBHOOKS_QUERY = """
query {
  webhooks(first: 100) {
    edges {
      node {
        id
        name
        isActive
        asyncEvents
        targetUrl
        subscriptionQuery
        eventDeliveries(first: 50, sortBy: { field: CREATED_AT, direction: DESC }) {
          edges { node { id createdAt status eventType payload } }
        }
      }
    }
  }
}"""

RECENT_ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 100, after: $cursor, sortBy: { field: LAST_MODIFIED_AT, direction: DESC }) {
    pageInfo { hasNextPage endCursor }
    edges { node { id number lastModifiedAt metadata { key value } privateMetadata { key value } } }
  }
}"""

WEBHOOK_UPDATE = """
mutation($id: ID!, $asyncEvents: [WebhookEventTypeAsyncEnum!], $subscriptionQuery: String) {
  webhookUpdate(id: $id, input: { asyncEvents: $asyncEvents, subscriptionQuery: $subscriptionQuery }) {
    webhook { id asyncEvents }
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


def classify_metadata_webhook_gap(metadata_updated_at, deliveries, subscribed_events):
    """
    metadata_updated_at: ISO8601 timestamp of the last metadata/private-metadata write on the order.
    deliveries: list of {"eventType": str, "createdAt": str} rows from Webhook.eventDeliveries,
                already filtered to this order's id and eventType in {"ORDER_UPDATED", "ORDER_METADATA_UPDATED"}.
    subscribed_events: the app's webhook.asyncEvents (or parsed subscriptionQuery event names).

    Returns one of:
      "MISCONFIGURED_SUBSCRIPTION"  -> app only subscribed to ORDER_UPDATED, never to ORDER_METADATA_UPDATED
                                       (by design in Saleor, metadata writes never fire ORDER_UPDATED)
      "DELIVERY_MISSING"            -> app IS subscribed to ORDER_METADATA_UPDATED but no delivery
                                       exists at/after metadata_updated_at (real delivery failure)
      "OK"                          -> a matching ORDER_METADATA_UPDATED delivery exists at/after the write
    Pure decision logic only; no network/DB calls.
    """
    if "ORDER_METADATA_UPDATED" not in subscribed_events:
        return "MISCONFIGURED_SUBSCRIPTION"
    has_matching_delivery = any(
        d["eventType"] == "ORDER_METADATA_UPDATED" and d["createdAt"] >= metadata_updated_at
        for d in deliveries
    )
    return "OK" if has_matching_delivery else "DELIVERY_MISSING"


def list_webhooks():
    data = gql(WEBHOOKS_QUERY)["webhooks"]
    return [edge["node"] for edge in data["edges"]]


def recently_touched_orders():
    cursor = None
    orders = []
    while True:
        data = gql(RECENT_ORDERS_QUERY, {"cursor": cursor})["orders"]
        orders.extend(edge["node"] for edge in data["edges"])
        if not data["pageInfo"]["hasNextPage"]:
            return orders
        cursor = data["pageInfo"]["endCursor"]


def has_metadata(order):
    return bool(order.get("metadata")) or bool(order.get("privateMetadata"))


def repair_subscription(webhook):
    events = sorted(set(webhook["asyncEvents"]) | {"ORDER_METADATA_UPDATED"})
    log.info("Would add ORDER_METADATA_UPDATED to webhook %s (%s)", webhook["id"], webhook["name"])
    if DRY_RUN:
        return
    result = gql(WEBHOOK_UPDATE, {
        "id": webhook["id"],
        "asyncEvents": events,
        "subscriptionQuery": webhook.get("subscriptionQuery"),
    })["webhookUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    log.info("Repaired webhook %s. asyncEvents now: %s", webhook["id"], result["webhook"]["asyncEvents"])


def run():
    webhooks = list_webhooks()
    orders = recently_touched_orders()

    misconfigured = []
    delivery_missing = []

    for webhook in webhooks:
        subscribed = set(webhook.get("asyncEvents") or [])
        if "ORDER_UPDATED" not in subscribed:
            continue  # this webhook does not even claim to track order updates

        deliveries = [
            {"eventType": e["node"]["eventType"], "createdAt": e["node"]["createdAt"]}
            for e in webhook["eventDeliveries"]["edges"]
            if e["node"]["eventType"] in ("ORDER_UPDATED", "ORDER_METADATA_UPDATED")
        ]

        for order in orders:
            if not has_metadata(order):
                continue
            metadata_updated_at = order["lastModifiedAt"]
            outcome = classify_metadata_webhook_gap(metadata_updated_at, deliveries, subscribed)
            if outcome == "MISCONFIGURED_SUBSCRIPTION":
                misconfigured.append(webhook)
                break  # one report per webhook is enough, it applies to every order
            if outcome == "DELIVERY_MISSING":
                delivery_missing.append((webhook, order))

    for webhook in misconfigured:
        log.warning(
            "MISCONFIGURED_SUBSCRIPTION webhook=%s name=%s asyncEvents=%s missing=ORDER_METADATA_UPDATED",
            webhook["id"], webhook["name"], webhook["asyncEvents"],
        )
        repair_subscription(webhook)

    for webhook, order in delivery_missing:
        log.warning(
            "DELIVERY_MISSING webhook=%s order=%s lastModifiedAt=%s. Manual reconciliation needed.",
            webhook["id"], order["number"], order["lastModifiedAt"],
        )

    log.info(
        "Done. %d webhook(s) %s, %d order-level delivery gap(s) reported.",
        len(misconfigured), "repaired" if not DRY_RUN else "to repair", len(delivery_missing),
    )
    return misconfigured, delivery_missing


if __name__ == "__main__":
    run()
