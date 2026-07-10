/**
 * Find Saleor webhooks and orders where a metadata write on an Order was
 * never seen because the app only subscribed to ORDER_UPDATED.
 *
 * updateMetadata and updatePrivateMetadata only mark metadata fields dirty.
 * Saleor's webhook dispatch logic checks for substantive order-field changes
 * before firing ORDER_UPDATED, and a metadata-only write never satisfies that
 * check (saleor/saleor#10166). Saleor fires a separate ORDER_METADATA_UPDATED
 * event for exactly this case instead, so an app subscribed only to
 * ORDER_UPDATED never learns the order changed.
 *
 * This script never re-fires a webhook, Saleor exposes no such mutation.
 * Under DRY_RUN=true (the default) it only reports misconfigured
 * subscriptions and order-level delivery gaps. When DRY_RUN=false it repairs
 * the subscription itself with webhookUpdate and re-verifies with a
 * follow-up eventDeliveries read. Order-level gaps stay report-only. Run on
 * a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/order-updated-webhook-skipped-on-metadata-change/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function classifyMetadataWebhookGap(metadataUpdatedAt, deliveries, subscribedEvents) {
  if (!subscribedEvents.has("ORDER_METADATA_UPDATED")) {
    return "MISCONFIGURED_SUBSCRIPTION";
  }
  const hasMatchingDelivery = deliveries.some(
    (d) => d.eventType === "ORDER_METADATA_UPDATED" && d.createdAt >= metadataUpdatedAt
  );
  return hasMatchingDelivery ? "OK" : "DELIVERY_MISSING";
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

const WEBHOOKS_QUERY = `
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
}`;

const RECENT_ORDERS_QUERY = `
query($cursor: String) {
  orders(first: 100, after: $cursor, sortBy: { field: LAST_MODIFIED_AT, direction: DESC }) {
    pageInfo { hasNextPage endCursor }
    edges { node { id number lastModifiedAt metadata { key value } privateMetadata { key value } } }
  }
}`;

const WEBHOOK_UPDATE = `
mutation($id: ID!, $asyncEvents: [WebhookEventTypeAsyncEnum!], $subscriptionQuery: String) {
  webhookUpdate(id: $id, input: { asyncEvents: $asyncEvents, subscriptionQuery: $subscriptionQuery }) {
    webhook { id asyncEvents }
    errors { field message code }
  }
}`;

async function listWebhooks() {
  const data = (await gql(WEBHOOKS_QUERY)).webhooks;
  return data.edges.map((edge) => edge.node);
}

async function recentlyTouchedOrders() {
  let cursor = null;
  const orders = [];
  while (true) {
    const data = (await gql(RECENT_ORDERS_QUERY, { cursor })).orders;
    orders.push(...data.edges.map((edge) => edge.node));
    if (!data.pageInfo.hasNextPage) return orders;
    cursor = data.pageInfo.endCursor;
  }
}

function hasMetadata(order) {
  return Boolean(order.metadata && order.metadata.length) || Boolean(order.privateMetadata && order.privateMetadata.length);
}

async function repairSubscription(webhook) {
  const events = Array.from(new Set([...(webhook.asyncEvents || []), "ORDER_METADATA_UPDATED"])).sort();
  console.log(`Would add ORDER_METADATA_UPDATED to webhook ${webhook.id} (${webhook.name})`);
  if (DRY_RUN) return;
  const result = (await gql(WEBHOOK_UPDATE, {
    id: webhook.id,
    asyncEvents: events,
    subscriptionQuery: webhook.subscriptionQuery ?? null,
  })).webhookUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  console.log(`Repaired webhook ${webhook.id}. asyncEvents now: ${result.webhook.asyncEvents}`);
}

export async function run() {
  const webhooks = await listWebhooks();
  const orders = await recentlyTouchedOrders();

  const misconfigured = [];
  const deliveryMissing = [];

  for (const webhook of webhooks) {
    const subscribed = new Set(webhook.asyncEvents || []);
    if (!subscribed.has("ORDER_UPDATED")) continue;

    const deliveries = webhook.eventDeliveries.edges
      .map((e) => e.node)
      .filter((n) => n.eventType === "ORDER_UPDATED" || n.eventType === "ORDER_METADATA_UPDATED")
      .map((n) => ({ eventType: n.eventType, createdAt: n.createdAt }));

    for (const order of orders) {
      if (!hasMetadata(order)) continue;
      const metadataUpdatedAt = order.lastModifiedAt;
      const outcome = classifyMetadataWebhookGap(metadataUpdatedAt, deliveries, subscribed);
      if (outcome === "MISCONFIGURED_SUBSCRIPTION") {
        misconfigured.push(webhook);
        break;
      }
      if (outcome === "DELIVERY_MISSING") {
        deliveryMissing.push({ webhook, order });
      }
    }
  }

  for (const webhook of misconfigured) {
    console.warn(
      `MISCONFIGURED_SUBSCRIPTION webhook=${webhook.id} name=${webhook.name} asyncEvents=${webhook.asyncEvents} missing=ORDER_METADATA_UPDATED`
    );
    await repairSubscription(webhook);
  }

  for (const { webhook, order } of deliveryMissing) {
    console.warn(
      `DELIVERY_MISSING webhook=${webhook.id} order=${order.number} lastModifiedAt=${order.lastModifiedAt}. Manual reconciliation needed.`
    );
  }

  console.log(
    `Done. ${misconfigured.length} webhook(s) ${DRY_RUN ? "to repair" : "repaired"}, ${deliveryMissing.length} order-level delivery gap(s) reported.`
  );
  return { misconfigured, deliveryMissing };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
