/**
 * Find Saleor webhooks whose delivered payload no longer matches the
 * fields their own subscriptionQuery asks for.
 *
 * Saleor supports two incompatible webhook payload mechanisms: a legacy
 * hard-coded shape documented with a sample payload per event, and a
 * subscription-defined shape set by the query field on Webhook, which
 * delivers exactly whatever that GraphQL query selects. There is no fixed
 * schema for a subscription webhook. Drift shows up when the query goes
 * stale after a Saleor field is renamed, deprecated, or moved behind a new
 * type (saleor/saleor#8054, #9500, discussion #14194), including behavior
 * changes like the 3.22 useLegacyUpdateWebhookEmission setting that altered
 * whether metadata-only updates fire *_UPDATED events at all.
 *
 * This script never rewrites a subscription query on its own. Under
 * DRY_RUN=true (the default) it only reports drift per webhook: missing
 * fields, unexpected fields, and a sample delivery id. When DRY_RUN=false
 * and NEW_SUBSCRIPTION_QUERY is set for a specific WEBHOOK_ID a human has
 * reviewed, it prints the old versus new query and calls webhookUpdate.
 * Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/webhook-payload-diverges-from-schema/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const WEBHOOK_ID = process.env.WEBHOOK_ID || "";
const NEW_SUBSCRIPTION_QUERY = process.env.NEW_SUBSCRIPTION_QUERY || "";

const GRAPHQL_KEYWORDS = new Set(["query", "mutation", "subscription", "fragment", "on"]);

// Documented sample fields for legacy (non-subscription) webhooks, per event
// type. Extend this as needed for events you run as legacy webhooks.
const LEGACY_SAMPLE_FIELDS = {
  PRODUCT_UPDATED: ["id", "name", "slug", "category"],
  ORDER_CREATED: ["id", "number", "status", "userEmail", "total"],
};

export function extractSelectionFields(fragmentBody) {
  // Flat field names selected at the top level of one braces-delimited
  // selection set, ignoring nested sub-selections.
  let depth = 0;
  const fields = new Set();
  let i = 0;
  const n = fragmentBody.length;
  while (i < n) {
    const ch = fragmentBody[i];
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }
    if (depth === 1) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*\{/.exec(fragmentBody.slice(i));
      if (m && !GRAPHQL_KEYWORDS.has(m[1])) {
        fields.add(m[1]);
        i += m[0].length - 1;
        continue;
      }
      const m2 = /^[A-Za-z_][A-Za-z0-9_]*/.exec(fragmentBody.slice(i));
      if (m2) {
        const token = m2[0];
        const rest = fragmentBody.slice(i + token.length).trimStart();
        if (!rest.startsWith("{") && !GRAPHQL_KEYWORDS.has(token)) {
          fields.add(token);
        }
        i += token.length;
        continue;
      }
    }
    i++;
  }
  return Array.from(fields).sort();
}

export function expectedFieldsFor(webhook, eventType) {
  const subscriptionQuery = webhook.subscriptionQuery;
  if (!subscriptionQuery) return LEGACY_SAMPLE_FIELDS[eventType] || [];
  const idx = subscriptionQuery.indexOf(`on ${eventType}`);
  const body = idx !== -1 ? subscriptionQuery.slice(idx) : subscriptionQuery;
  return extractSelectionFields(body);
}

export function diffPayloadAgainstSchema(payload, expectedFields, options = {}) {
  const path = options.path || "";
  const label = (name) => (path ? `${path}.${name}` : name);

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      missingInPayload: expectedFields.map(label).sort(),
      unexpectedInPayload: [],
    };
  }

  const expectedSet = new Set(expectedFields);
  const payloadKeys = Object.keys(payload);

  const missingInPayload = expectedFields
    .filter((field) => !(field in payload) || payload[field] === null)
    .map(label)
    .sort();

  const unexpectedInPayload = payloadKeys
    .filter((key) => !expectedSet.has(key))
    .map(label)
    .sort();

  return { missingInPayload, unexpectedInPayload };
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
      node { id name targetUrl isActive subscriptionQuery events }
    }
  }
}`;

const DELIVERIES_QUERY = `
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
}`;

const WEBHOOK_UPDATE = `
mutation($id: ID!, $query: String!) {
  webhookUpdate(id: $id, input: { query: $query }) {
    webhook { id subscriptionQuery }
    errors { field message code }
  }
}`;

async function listWebhooks() {
  const data = (await gql(WEBHOOKS_QUERY)).webhooks;
  return data.edges.map((edge) => edge.node);
}

async function recentDeliveries(webhookId) {
  const data = (await gql(DELIVERIES_QUERY, { webhookId })).webhook;
  return data.eventDeliveries.edges.map((edge) => edge.node);
}

async function applyNewQuery(webhookId, oldQuery, newQuery) {
  console.log(`Old query for ${webhookId}:\n${oldQuery}`);
  console.log(`New query for ${webhookId}:\n${newQuery}`);
  if (DRY_RUN) {
    console.log("Dry run, not calling webhookUpdate.");
    return;
  }
  const result = (await gql(WEBHOOK_UPDATE, { id: webhookId, query: newQuery })).webhookUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  console.log(`webhookUpdate applied for ${webhookId}.`);
}

export async function run() {
  const reports = [];
  const webhooks = await listWebhooks();

  for (const webhook of webhooks) {
    const deliveries = await recentDeliveries(webhook.id);
    for (const delivery of deliveries.slice(0, 5)) {
      let payload;
      try {
        payload = JSON.parse(delivery.payload);
      } catch {
        console.warn(`Webhook ${webhook.name} delivery ${delivery.id}: payload did not parse as JSON.`);
        continue;
      }
      const expected = expectedFieldsFor(webhook, delivery.eventType);
      if (!expected.length) continue;
      const result = diffPayloadAgainstSchema(payload, expected);
      if (result.missingInPayload.length || result.unexpectedInPayload.length) {
        reports.push({
          webhookId: webhook.id,
          webhookName: webhook.name,
          eventType: delivery.eventType,
          sampleDeliveryId: delivery.id,
          ...result,
        });
        console.warn(
          `DRIFT webhook=${webhook.name} event=${delivery.eventType} missing=${JSON.stringify(result.missingInPayload)} unexpected=${JSON.stringify(result.unexpectedInPayload)} delivery=${delivery.id}`
        );
      }
    }
  }

  if (WEBHOOK_ID && NEW_SUBSCRIPTION_QUERY) {
    const target = webhooks.find((w) => w.id === WEBHOOK_ID);
    if (target) {
      await applyNewQuery(WEBHOOK_ID, target.subscriptionQuery || "", NEW_SUBSCRIPTION_QUERY);
    }
  }

  console.log(`Done. ${reports.length} webhook delivery report(s) with drift.`);
  return reports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
