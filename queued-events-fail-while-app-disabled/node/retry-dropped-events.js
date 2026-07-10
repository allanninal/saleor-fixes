/**
 * Find and retry Saleor EventDelivery rows that were marked FAILED because
 * the webhook or its app was disabled at the moment a queued event was
 * popped off the Celery task queue.
 *
 * Saleor's dispatcher checks Webhook.isActive and App.isActive at task
 * execution time, not when the event was enqueued. Disabling an app, by
 * hand or through the circuit breaker after repeated delivery failures,
 * does not pause the queue: anything already queued still gets popped,
 * sees the webhook or app inactive, and is written to EventDelivery with
 * status FAILED, a terminal state with no attempt made and no automatic
 * retry. Re-enabling the app only resumes delivery for events enqueued
 * after that point.
 *
 * Saleor has no bulk-replay mutation, so repair is a guarded, per-delivery
 * retry loop over eventDeliveryRetry. Under DRY_RUN=true (the default) it
 * only prints the ids it would retry or flag. When DRY_RUN=false it calls
 * eventDeliveryRetry for real, but only for deliveries whose payload is
 * still inside EVENT_PAYLOAD_DELETE_PERIOD (14 days by default); anything
 * older or already purged is flagged for manual reconciliation instead.
 * Run it once per disabled window.
 *
 * Guide: https://www.allanninal.dev/saleor/queued-events-fail-while-app-disabled/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const APP_ID = process.env.APP_ID || "gid://saleor/App/1";
const APP_DISABLED_AT = process.env.APP_DISABLED_AT || new Date().toISOString();
const APP_REENABLED_AT = process.env.APP_REENABLED_AT || null;
const RETENTION_DAYS = Number(process.env.EVENT_PAYLOAD_RETENTION_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export const RETENTION_DAYS_DEFAULT = 14;

/**
 * Pure decision logic, no I/O.
 *
 * deliveries: array of {id, createdAt, status, eventType, payload}
 * appDisabledAt / appReenabledAt / now: ISO 8601 strings (appReenabledAt may be null)
 * retentionDays: EVENT_PAYLOAD_DELETE_PERIOD, in days
 *
 * Returns an array of {id, action} where action is one of
 * "RETRY", "FLAG_UNRECOVERABLE", "SKIP".
 */
export function classifyDroppedDeliveries(deliveries, appDisabledAt, appReenabledAt, now, retentionDays = RETENTION_DAYS_DEFAULT) {
  const windowStart = new Date(appDisabledAt);
  const windowEnd = new Date(appReenabledAt || now);
  const nowDate = new Date(now);

  return deliveries.map((d) => {
    if (d.status !== "FAILED") return { id: d.id, action: "SKIP" };

    const created = new Date(d.createdAt);
    if (created < windowStart || created > windowEnd) return { id: d.id, action: "SKIP" };

    const ageDays = (nowDate - created) / 86400000;
    if (d.payload === null || d.payload === undefined || ageDays > retentionDays) {
      return { id: d.id, action: "FLAG_UNRECOVERABLE" };
    }

    return { id: d.id, action: "RETRY" };
  });
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

const APP_WEBHOOKS_QUERY = `
query($appId: ID!) {
  app(id: $appId) {
    id
    name
    isActive
    webhooks { id name isActive targetUrl }
  }
}`;

const FAILED_DELIVERIES_QUERY = `
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
}`;

const RETRY_MUTATION = `
mutation($id: ID!) {
  eventDeliveryRetry(id: $id) {
    delivery { id status }
    errors { field message code }
  }
}`;

async function appWebhooks(appId) {
  const data = (await gql(APP_WEBHOOKS_QUERY, { appId })).app;
  return data ? data.webhooks : [];
}

async function* failedDeliveries(webhookId) {
  let cursor = null;
  while (true) {
    const data = (await gql(FAILED_DELIVERIES_QUERY, { webhookId, after: cursor })).webhook;
    for (const edge of data.eventDeliveries.edges) yield edge.node;
    const page = data.eventDeliveries.pageInfo;
    if (!page.hasNextPage) return;
    cursor = page.endCursor;
  }
}

async function retryDelivery(deliveryId) {
  const result = (await gql(RETRY_MUTATION, { id: deliveryId })).eventDeliveryRetry;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.delivery.status;
}

export async function run() {
  const nowIso = new Date().toISOString();
  const webhooks = await appWebhooks(APP_ID);

  let retried = 0;
  let flagged = 0;
  for (const webhook of webhooks) {
    const deliveries = [];
    for await (const node of failedDeliveries(webhook.id)) deliveries.push(node);
    const decisions = classifyDroppedDeliveries(deliveries, APP_DISABLED_AT, APP_REENABLED_AT, nowIso, RETENTION_DAYS);
    const byId = new Map(deliveries.map((d) => [d.id, d]));

    for (const decision of decisions) {
      if (decision.action === "SKIP") continue;
      const delivery = byId.get(decision.id);
      if (decision.action === "FLAG_UNRECOVERABLE") {
        console.warn(
          `UNRECOVERABLE webhook=${webhook.name} eventType=${delivery.eventType} id=${delivery.id} createdAt=${delivery.createdAt} (payload purged past retention)`
        );
        flagged++;
        continue;
      }

      console.log(
        `RETRY webhook=${webhook.name} eventType=${delivery.eventType} id=${delivery.id} createdAt=${delivery.createdAt} ${DRY_RUN ? "would retry" : "retrying"}`
      );
      if (!DRY_RUN) await retryDelivery(delivery.id);
      retried++;
    }
  }

  console.log(`Done. ${retried} delivery(ies) ${DRY_RUN ? "to retry" : "retried"}, ${flagged} flagged unrecoverable.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
