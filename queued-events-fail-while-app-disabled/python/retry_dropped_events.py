"""Find and retry Saleor EventDelivery rows that were marked FAILED because
the webhook or its app was disabled at the moment a queued event was popped
off the Celery task queue.

Saleor's dispatcher checks Webhook.isActive and App.isActive at task
execution time, not when the event was enqueued. Disabling an app, by hand
or through the circuit breaker after repeated delivery failures, does not
pause the queue: anything already queued still gets popped, sees the
webhook or app inactive, and is written to EventDelivery with status FAILED,
a terminal state with no attempt made and no automatic retry. Re-enabling
the app only resumes delivery for events enqueued after that point.

Saleor has no bulk-replay mutation, so repair is a guarded, per-delivery
retry loop over eventDeliveryRetry. Under DRY_RUN=true (the default) it
only prints the ids it would retry or flag. When DRY_RUN=false it calls
eventDeliveryRetry for real, but only for deliveries whose payload is
still inside EVENT_PAYLOAD_DELETE_PERIOD (14 days by default); anything
older or already purged is flagged for manual reconciliation instead.
Run it once per disabled window. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/queued-events-fail-while-app-disabled/
"""
import os
import datetime
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("retry_dropped_events")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
APP_ID = os.environ.get("APP_ID", "gid://saleor/App/1")
APP_DISABLED_AT = os.environ.get("APP_DISABLED_AT", "1970-01-01T00:00:00Z")
APP_REENABLED_AT = os.environ.get("APP_REENABLED_AT") or None
RETENTION_DAYS = int(os.environ.get("EVENT_PAYLOAD_RETENTION_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

APP_WEBHOOKS_QUERY = """
query($appId: ID!) {
  app(id: $appId) {
    id
    name
    isActive
    webhooks { id name isActive targetUrl }
  }
}"""

FAILED_DELIVERIES_QUERY = """
query($webhookId: ID!, $after: String) {
  webhook(id: $webhookId) {
    eventDeliveries(first: 100, after: $after, filter: { status: FAILED }) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          eventType
          status
          payload
        }
      }
    }
  }
}"""

RETRY_MUTATION = """
mutation($id: ID!) {
  eventDeliveryRetry(id: $id) {
    delivery { id status }
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


def _parse(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def classify_dropped_deliveries(deliveries, app_disabled_at, app_reenabled_at, now, retention_days=RETENTION_DAYS):
    """Pure decision logic, no I/O.

    deliveries: list of {id, createdAt, status, eventType, payload}
    app_disabled_at / app_reenabled_at / now: ISO 8601 timestamps (app_reenabled_at may be None)
    retention_days: EVENT_PAYLOAD_DELETE_PERIOD, in days

    Returns a list of {id, action} where action is one of
    "RETRY", "FLAG_UNRECOVERABLE", "SKIP".
    """
    window_start = _parse(app_disabled_at)
    window_end = _parse(app_reenabled_at) if app_reenabled_at else _parse(now)
    now_dt = _parse(now)

    results = []
    for d in deliveries:
        if d["status"] != "FAILED":
            results.append({"id": d["id"], "action": "SKIP"})
            continue

        created = _parse(d["createdAt"])
        if created < window_start or created > window_end:
            results.append({"id": d["id"], "action": "SKIP"})
            continue

        age_days = (now_dt - created).total_seconds() / 86400
        if d.get("payload") is None or age_days > retention_days:
            results.append({"id": d["id"], "action": "FLAG_UNRECOVERABLE"})
            continue

        results.append({"id": d["id"], "action": "RETRY"})
    return results


def app_webhooks(app_id):
    data = gql(APP_WEBHOOKS_QUERY, {"appId": app_id})["app"]
    return data["webhooks"] if data else []


def failed_deliveries(webhook_id):
    cursor = None
    while True:
        data = gql(FAILED_DELIVERIES_QUERY, {"webhookId": webhook_id, "after": cursor})["webhook"]
        for edge in data["eventDeliveries"]["edges"]:
            yield edge["node"]
        page = data["eventDeliveries"]["pageInfo"]
        if not page["hasNextPage"]:
            return
        cursor = page["endCursor"]


def retry_delivery(delivery_id):
    result = gql(RETRY_MUTATION, {"id": delivery_id})["eventDeliveryRetry"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["delivery"]["status"]


def run():
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    webhooks = app_webhooks(APP_ID)

    retried = 0
    flagged = 0
    for webhook in webhooks:
        deliveries = list(failed_deliveries(webhook["id"]))
        decisions = classify_dropped_deliveries(deliveries, APP_DISABLED_AT, APP_REENABLED_AT, now_iso, RETENTION_DAYS)
        by_id = {d["id"]: d for d in deliveries}

        for decision in decisions:
            if decision["action"] == "SKIP":
                continue
            delivery = by_id[decision["id"]]
            if decision["action"] == "FLAG_UNRECOVERABLE":
                log.warning(
                    "UNRECOVERABLE webhook=%s eventType=%s id=%s createdAt=%s (payload purged past retention)",
                    webhook["name"], delivery["eventType"], delivery["id"], delivery["createdAt"],
                )
                flagged += 1
                continue

            log.info(
                "RETRY webhook=%s eventType=%s id=%s createdAt=%s %s",
                webhook["name"], delivery["eventType"], delivery["id"], delivery["createdAt"],
                "would retry" if DRY_RUN else "retrying",
            )
            if not DRY_RUN:
                retry_delivery(delivery["id"])
            retried += 1

    log.info(
        "Done. %d delivery(ies) %s, %d flagged unrecoverable.",
        retried, "to retry" if DRY_RUN else "retried", flagged,
    )


if __name__ == "__main__":
    run()
