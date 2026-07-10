"""Find Saleor webhook EventDeliveries stuck FAILED past Celery's retry limit
and retry only the ones that look worth retrying.

send_webhook_request (saleor/plugins/webhook/tasks.py) retries an async
delivery with retry_backoff=10 and retry_kwargs={"max_retries": 5}, roughly
10 * 2^n seconds of delay across 5 attempts. Once the fifth retry also
fails, Celery never reschedules the task again and the EventDelivery is
persisted as FAILED for good. Nothing in Saleor resurrects it later.

Under DRY_RUN=true (the default) this only reports what it would do. When
DRY_RUN=false it calls eventDeliveryRetry once per delivery classified
RETRY, and re-polls its status to confirm it left FAILED. Deliveries whose
recent attempts all look like a dead endpoint (5xx or no response code)
are only ever reported, never retried. Run on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/saleor/webhook-deliveries-stuck-failed/
"""
import os
import time
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("retry_stale_failed_deliveries")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
STALE_AFTER_MINUTES = float(os.environ.get("STALE_AFTER_MINUTES", "60"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DEFAULT_MAX_RETRIES = 5
DEFAULT_STALE_AFTER_MS = 3600000  # 1 hour, Saleor's Celery max_retries=5

FAILED_DELIVERIES_QUERY = """
query {
  webhooks(first: 50) {
    edges {
      node {
        id
        name
        isActive
        targetUrl
        eventDeliveries(first: 100, filter: { status: FAILED },
                         sortBy: { field: CREATED_AT, direction: DESC }) {
          edges {
            node {
              id
              eventType
              createdAt
              status
              attempts(first: 5, sortBy: { field: CREATED_AT, direction: DESC }) {
                edges { node { id createdAt status duration responseStatusCode taskId } }
              }
            }
          }
        }
      }
    }
  }
}"""

DELIVERY_STATUS_QUERY = """
query($id: ID!) {
  eventDelivery(id: $id) { id status }
}"""

RETRY_MUTATION = """
mutation($id: ID!) {
  eventDeliveryRetry(id: $id) {
    delivery { id status }
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


def _parse_iso_ms(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def _looks_dead(attempt):
    code = attempt.get("responseStatusCode")
    return code is None or code >= 500


def decide_stale_failed_retries(deliveries, now_iso, opts=None):
    """Pure decision function: no I/O, fully unit-testable.

    deliveries: list of {id, status, createdAt, attempts: [{createdAt, responseStatusCode}]}
    now_iso: ISO 8601 timestamp string
    opts: optional {maxRetries, staleAfterMs}

    Returns a list of {id, action, reason} where action is one of
    'RETRY', 'FLAG_DEAD_ENDPOINT', 'SKIP'.
    """
    opts = opts or {}
    max_retries = opts.get("maxRetries", DEFAULT_MAX_RETRIES)
    stale_after_ms = opts.get("staleAfterMs", DEFAULT_STALE_AFTER_MS)
    now_ms = _parse_iso_ms(now_iso)

    decisions = []
    for delivery in deliveries:
        if delivery.get("status") != "FAILED":
            decisions.append({"id": delivery["id"], "action": "SKIP", "reason": "not-failed"})
            continue

        attempts = delivery.get("attempts") or []
        attempt_count = len(attempts)
        last_attempt_at = delivery.get("createdAt")
        if attempts:
            last_attempt_at = max(a["createdAt"] for a in attempts)
        age_ms = now_ms - _parse_iso_ms(last_attempt_at)

        if attempt_count < max_retries and age_ms < stale_after_ms:
            # Saleor's own Celery retries may still be in flight, don't race them.
            decisions.append({"id": delivery["id"], "action": "SKIP", "reason": "still-within-retry-window"})
            continue

        if attempt_count >= max_retries and age_ms >= stale_after_ms:
            recent = attempts[:max_retries]
            all_dead = all(_looks_dead(a) for a in recent) if recent else False
            if all_dead:
                decisions.append({"id": delivery["id"], "action": "FLAG_DEAD_ENDPOINT",
                                   "reason": "endpoint-repeatedly-unreachable"})
            else:
                decisions.append({"id": delivery["id"], "action": "RETRY",
                                   "reason": "stale-failed-past-retry-limit-transient-error"})
            continue

        decisions.append({"id": delivery["id"], "action": "SKIP",
                           "reason": "recently-exhausted-wait-for-staleness-window"})

    return decisions


def failed_deliveries_by_webhook():
    data = gql(FAILED_DELIVERIES_QUERY)["webhooks"]
    for edge in data["edges"]:
        webhook = edge["node"]
        deliveries = [d["node"] for d in webhook["eventDeliveries"]["edges"]]
        yield webhook, deliveries


def retry_delivery(delivery_id):
    result = gql(RETRY_MUTATION, {"id": delivery_id})["eventDeliveryRetry"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["delivery"]["status"]


def confirm_left_failed(delivery_id):
    data = gql(DELIVERY_STATUS_QUERY, {"id": delivery_id})["eventDelivery"]
    return data["status"] if data else None


def run():
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    opts = {"staleAfterMs": STALE_AFTER_MINUTES * 60 * 1000}

    retried = 0
    flagged = 0
    for webhook, deliveries in failed_deliveries_by_webhook():
        decisions = decide_stale_failed_retries(deliveries, now_iso, opts)
        by_id = {d["id"]: d for d in deliveries}

        for decision in decisions:
            if decision["action"] == "SKIP":
                continue

            delivery = by_id[decision["id"]]

            if decision["action"] == "FLAG_DEAD_ENDPOINT":
                codes = [a.get("responseStatusCode") for a in (delivery.get("attempts") or [])]
                log.warning(
                    "DEAD ENDPOINT webhook=%s (%s) delivery=%s eventType=%s recent_codes=%s",
                    webhook["name"], webhook["targetUrl"], delivery["id"], delivery["eventType"], codes,
                )
                flagged += 1
                continue

            if decision["action"] == "RETRY":
                if DRY_RUN:
                    log.info("[DRY RUN] would retry delivery %s (%s, %s)",
                              delivery["id"], delivery["eventType"], webhook["name"])
                else:
                    log.info("Retrying delivery %s (%s, %s)",
                              delivery["id"], delivery["eventType"], webhook["name"])
                    retry_delivery(delivery["id"])
                    time.sleep(2)
                    status = confirm_left_failed(delivery["id"])
                    log.info("Delivery %s status after retry: %s", delivery["id"], status)
                retried += 1

    log.info(
        "Done. %d delivery(ies) %s, %d dead endpoint(s) flagged for review.",
        retried, "to retry" if DRY_RUN else "retried", flagged,
    )


if __name__ == "__main__":
    run()
