"""Find Saleor webhooks whose delivered payload no longer matches the
fields their own subscriptionQuery asks for.

Saleor supports two incompatible webhook payload mechanisms: a legacy
hard-coded shape documented with a sample payload per event, and a
subscription-defined shape set by the query field on Webhook, which
delivers exactly whatever that GraphQL query selects. There is no fixed
schema for a subscription webhook. Drift shows up when the query goes
stale after a Saleor field is renamed, deprecated, or moved behind a new
type (saleor/saleor#8054, #9500, discussion #14194), including behavior
changes like the 3.22 useLegacyUpdateWebhookEmission setting that altered
whether metadata-only updates fire *_UPDATED events at all.

This script never rewrites a subscription query on its own. Under
DRY_RUN=true (the default) it only reports drift per webhook: missing
fields, unexpected fields, and a sample delivery id. When DRY_RUN=false
and NEW_SUBSCRIPTION_QUERY is set for a specific WEBHOOK_ID a human has
reviewed, it prints the old versus new query and calls webhookUpdate.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/webhook-payload-diverges-from-schema/
"""
import os
import re
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_webhook_payload_drift")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
WEBHOOK_ID = os.environ.get("WEBHOOK_ID", "")
NEW_SUBSCRIPTION_QUERY = os.environ.get("NEW_SUBSCRIPTION_QUERY", "")

GRAPHQL_KEYWORDS = {"query", "mutation", "subscription", "fragment", "on"}
FIELD_TOKEN = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*\{")

# Documented sample fields for legacy (non-subscription) webhooks, per event
# type. Extend this as needed for events you run as legacy webhooks.
LEGACY_SAMPLE_FIELDS = {
    "PRODUCT_UPDATED": ["id", "name", "slug", "category"],
    "ORDER_CREATED": ["id", "number", "status", "userEmail", "total"],
}

WEBHOOKS_QUERY = """
query {
  webhooks(first: 100) {
    edges {
      node { id name targetUrl isActive subscriptionQuery events }
    }
  }
}"""

DELIVERIES_QUERY = """
query($webhookId: ID!) {
  webhook(id: $webhookId) {
    eventDeliveries(first: 50, sortBy: { field: CREATED_AT, direction: DESC }) {
      edges {
        node {
          id eventType payload createdAt
          attempts(first: 1) { edges { node { responseStatusCode response } } }
        }
      }
    }
  }
}"""

WEBHOOK_UPDATE = """
mutation($id: ID!, $query: String!) {
  webhookUpdate(id: $id, input: { query: $query }) {
    webhook { id subscriptionQuery }
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


def extract_selection_fields(fragment_body):
    """Return the flat field names selected at the top level of one
    braces-delimited selection set, ignoring nested sub-selections."""
    depth = 0
    fields = []
    i = 0
    n = len(fragment_body)
    while i < n:
        ch = fragment_body[i]
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth -= 1
            i += 1
            continue
        if depth == 1:
            m = FIELD_TOKEN.match(fragment_body, i)
            if m and m.group(1) not in GRAPHQL_KEYWORDS:
                fields.append(m.group(1))
                i = m.end() - 1
                continue
            m2 = re.match(r"[A-Za-z_][A-Za-z0-9_]*", fragment_body[i:])
            if m2:
                token = m2.group(0)
                nxt = fragment_body[i + len(token):].lstrip()
                if not nxt.startswith("{") and token not in GRAPHQL_KEYWORDS:
                    fields.append(token)
                i += len(token)
                continue
        i += 1
    return sorted(set(fields))


def expected_fields_for(webhook, event_type):
    subscription_query = webhook.get("subscriptionQuery")
    if not subscription_query:
        return LEGACY_SAMPLE_FIELDS.get(event_type, [])
    idx = subscription_query.find(f"on {event_type}")
    body = subscription_query
    if idx != -1:
        body = subscription_query[idx:]
    return extract_selection_fields(body)


def diff_payload_against_schema(payload, expected_fields, path=""):
    missing_in_payload = []
    unexpected_in_payload = []

    if not isinstance(payload, dict):
        return {
            "missingInPayload": [f"{path}.{f}" if path else f for f in expected_fields],
            "unexpectedInPayload": [],
        }

    expected_set = set(expected_fields)
    payload_keys = set(payload.keys())

    for field in expected_fields:
        label = f"{path}.{field}" if path else field
        if field not in payload or payload[field] is None:
            missing_in_payload.append(label)

    for key in payload_keys:
        label = f"{path}.{key}" if path else key
        if key not in expected_set:
            unexpected_in_payload.append(label)

    return {
        "missingInPayload": sorted(missing_in_payload),
        "unexpectedInPayload": sorted(unexpected_in_payload),
    }


def list_webhooks():
    data = gql(WEBHOOKS_QUERY)["webhooks"]
    return [edge["node"] for edge in data["edges"]]


def recent_deliveries(webhook_id):
    data = gql(DELIVERIES_QUERY, {"webhookId": webhook_id})["webhook"]
    return [edge["node"] for edge in data["eventDeliveries"]["edges"]]


def apply_new_query(webhook_id, old_query, new_query):
    log.info("Old query for %s:\n%s", webhook_id, old_query)
    log.info("New query for %s:\n%s", webhook_id, new_query)
    if DRY_RUN:
        log.info("Dry run, not calling webhookUpdate.")
        return
    result = gql(WEBHOOK_UPDATE, {"id": webhook_id, "query": new_query})["webhookUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    log.info("webhookUpdate applied for %s.", webhook_id)


def run():
    reports = []
    for webhook in list_webhooks():
        deliveries = recent_deliveries(webhook["id"])
        for delivery in deliveries[:5]:
            try:
                payload = json.loads(delivery["payload"])
            except (TypeError, ValueError):
                log.warning("Webhook %s delivery %s: payload did not parse as JSON.",
                            webhook["name"], delivery["id"])
                continue
            expected = expected_fields_for(webhook, delivery["eventType"])
            if not expected:
                continue
            result = diff_payload_against_schema(payload, expected)
            if result["missingInPayload"] or result["unexpectedInPayload"]:
                report = {
                    "webhookId": webhook["id"],
                    "webhookName": webhook["name"],
                    "eventType": delivery["eventType"],
                    "sampleDeliveryId": delivery["id"],
                    **result,
                }
                reports.append(report)
                log.warning(
                    "DRIFT webhook=%s event=%s missing=%s unexpected=%s delivery=%s",
                    webhook["name"], delivery["eventType"],
                    result["missingInPayload"], result["unexpectedInPayload"], delivery["id"],
                )

    if WEBHOOK_ID and NEW_SUBSCRIPTION_QUERY:
        target = next((w for w in list_webhooks() if w["id"] == WEBHOOK_ID), None)
        if target:
            apply_new_query(WEBHOOK_ID, target.get("subscriptionQuery") or "", NEW_SUBSCRIPTION_QUERY)

    log.info("Done. %d webhook delivery report(s) with drift.", len(reports))
    return reports


if __name__ == "__main__":
    run()
