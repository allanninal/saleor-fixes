/**
 * Find Saleor webhook EventDeliveries stuck FAILED past Celery's retry limit
 * and retry only the ones that look worth retrying.
 *
 * send_webhook_request (saleor/plugins/webhook/tasks.py) retries an async
 * delivery with retry_backoff=10 and retry_kwargs={"max_retries": 5}, roughly
 * 10 * 2^n seconds of delay across 5 attempts. Once the fifth retry also
 * fails, Celery never reschedules the task again and the EventDelivery is
 * persisted as FAILED for good. Nothing in Saleor resurrects it later.
 *
 * Under DRY_RUN=true (the default) this only reports what it would do. When
 * DRY_RUN=false it calls eventDeliveryRetry once per delivery classified
 * RETRY, and re-polls its status to confirm it left FAILED. Deliveries whose
 * recent attempts all look like a dead endpoint (5xx or no response code)
 * are only ever reported, never retried. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/webhook-deliveries-stuck-failed/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const STALE_AFTER_MINUTES = Number(process.env.STALE_AFTER_MINUTES || 60);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_STALE_AFTER_MS = 3600000; // 1 hour, Saleor's Celery max_retries=5

/**
 * Pure decision function: no I/O, fully unit-testable.
 *
 * @param {Array<{id: string, status: string, createdAt: string, attempts: Array<{createdAt: string, responseStatusCode?: number}>}>} deliveries
 * @param {string} nowIso
 * @param {{maxRetries?: number, staleAfterMs?: number}} [opts]
 * @returns {Array<{id: string, action: 'RETRY'|'FLAG_DEAD_ENDPOINT'|'SKIP', reason: string}>}
 */
export function decideStaleFailedRetries(deliveries, nowIso, opts = {}) {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const nowMs = Date.parse(nowIso);

  return deliveries.map((delivery) => {
    if (delivery.status !== "FAILED") {
      return { id: delivery.id, action: "SKIP", reason: "not-failed" };
    }

    const attempts = delivery.attempts || [];
    const attemptCount = attempts.length;
    const lastAttemptAt = attempts.length
      ? attempts.reduce((max, a) => (a.createdAt > max ? a.createdAt : max), attempts[0].createdAt)
      : delivery.createdAt;
    const ageMs = nowMs - Date.parse(lastAttemptAt);

    if (attemptCount < maxRetries && ageMs < staleAfterMs) {
      // Saleor's own Celery retries may still be in flight, don't race them.
      return { id: delivery.id, action: "SKIP", reason: "still-within-retry-window" };
    }

    if (attemptCount >= maxRetries && ageMs >= staleAfterMs) {
      const recent = attempts.slice(0, maxRetries);
      const allDead = recent.length > 0 && recent.every(looksDead);
      return allDead
        ? { id: delivery.id, action: "FLAG_DEAD_ENDPOINT", reason: "endpoint-repeatedly-unreachable" }
        : { id: delivery.id, action: "RETRY", reason: "stale-failed-past-retry-limit-transient-error" };
    }

    return { id: delivery.id, action: "SKIP", reason: "recently-exhausted-wait-for-staleness-window" };
  });
}

function looksDead(attempt) {
  const code = attempt.responseStatusCode;
  return code === null || code === undefined || code >= 500;
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Saleor ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const FAILED_DELIVERIES_QUERY = `
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
}`;

const DELIVERY_STATUS_QUERY = `
query($id: ID!) {
  eventDelivery(id: $id) { id status }
}`;

const RETRY_MUTATION = `
mutation($id: ID!) {
  eventDeliveryRetry(id: $id) {
    delivery { id status }
    errors { field code message }
  }
}`;

async function* failedDeliveriesByWebhook() {
  const data = (await gql(FAILED_DELIVERIES_QUERY)).webhooks;
  for (const edge of data.edges) {
    const webhook = edge.node;
    const deliveries = webhook.eventDeliveries.edges.map((d) => d.node);
    yield { webhook, deliveries };
  }
}

async function retryDelivery(deliveryId) {
  const result = (await gql(RETRY_MUTATION, { id: deliveryId })).eventDeliveryRetry;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.delivery.status;
}

async function confirmLeftFailed(deliveryId) {
  const data = (await gql(DELIVERY_STATUS_QUERY, { id: deliveryId })).eventDelivery;
  return data ? data.status : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run() {
  const nowIso = new Date().toISOString();
  const opts = { staleAfterMs: STALE_AFTER_MINUTES * 60 * 1000 };

  let retried = 0;
  let flagged = 0;

  for await (const { webhook, deliveries } of failedDeliveriesByWebhook()) {
    const decisions = decideStaleFailedRetries(deliveries, nowIso, opts);
    const byId = new Map(deliveries.map((d) => [d.id, d]));

    for (const decision of decisions) {
      if (decision.action === "SKIP") continue;
      const delivery = byId.get(decision.id);

      if (decision.action === "FLAG_DEAD_ENDPOINT") {
        const codes = (delivery.attempts || []).map((a) => a.responseStatusCode);
        console.warn(
          `DEAD ENDPOINT webhook=${webhook.name} (${webhook.targetUrl}) delivery=${delivery.id} eventType=${delivery.eventType} recent_codes=${JSON.stringify(codes)}`
        );
        flagged++;
        continue;
      }

      if (decision.action === "RETRY") {
        console.log(
          DRY_RUN
            ? `[DRY RUN] would retry delivery ${delivery.id} (${delivery.eventType}, ${webhook.name})`
            : `Retrying delivery ${delivery.id} (${delivery.eventType}, ${webhook.name})`
        );
        if (!DRY_RUN) {
          await retryDelivery(delivery.id);
          await sleep(2000);
          const status = await confirmLeftFailed(delivery.id);
          console.log(`Delivery ${delivery.id} status after retry: ${status}`);
        }
        retried++;
      }
    }
  }

  console.log(
    `Done. ${retried} delivery(ies) ${DRY_RUN ? "to retry" : "retried"}, ${flagged} dead endpoint(s) flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
