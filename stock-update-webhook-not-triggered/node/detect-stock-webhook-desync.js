/**
 * Find Saleor variant and warehouse pairs whose Stock.quantity changed
 * without a matching PRODUCT_VARIANT_STOCK_UPDATED webhook delivery.
 *
 * PRODUCT_VARIANT_STOCK_UPDATED only fires from productVariantStocksUpdate,
 * stockBulkUpdate, and productVariantStocksCreate/Delete. Quantity changes
 * from orderFulfill, order cancellation or refund, and draft order completion
 * mutate Stock directly through allocation helpers that never call
 * stock_bulk_updated (saleor/saleor#11630, #11637, #6479), so no webhook is
 * ever created even though the quantity genuinely changed.
 *
 * This script never re-fires a webhook, Saleor exposes no such mutation.
 * Under DRY_RUN=true (the default) it only reports desynced pairs. When
 * DRY_RUN=false it POSTs a synthetic reconciliation payload to your own
 * external endpoint, shaped like the real webhook payload. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/stock-update-webhook-not-triggered/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const WEBHOOK_ID = process.env.SALEOR_WEBHOOK_ID || "";
const RECONCILE_ENDPOINT = process.env.RECONCILE_ENDPOINT || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CRITICAL_HINTS = new Set(["ORDER_FULFILL", "ORDER_CANCEL"]);
const CRITICAL_DELTA_RATIO = 0.10;

/**
 * Pure decision function. No I/O.
 * record: { variantId, warehouseId, quantityBefore, quantityAfter,
 *           matchingDeliveryFound, recentMutationHint, pollWindowMs? }
 */
export function classifyStockDesync(record) {
  const { quantityBefore, quantityAfter } = record;

  if (quantityBefore === quantityAfter) {
    return { isDesynced: false, severity: "none", reason: "no change" };
  }

  if (record.matchingDeliveryFound) {
    return { isDesynced: false, severity: "none", reason: "webhook delivered" };
  }

  const delta = quantityAfter - quantityBefore;
  const hint = record.recentMutationHint || "UNKNOWN";
  const crossesZero = (quantityBefore === 0) !== (quantityAfter === 0);
  const largeDelta = quantityBefore !== 0 && Math.abs(delta) >= Math.abs(quantityBefore) * CRITICAL_DELTA_RATIO;

  const severity = CRITICAL_HINTS.has(hint) || largeDelta || crossesZero ? "critical" : "warn";
  const sign = delta >= 0 ? "+" : "";
  const reason = `suspected ${hint}, delta ${sign}${delta} with no matching PRODUCT_VARIANT_STOCK_UPDATED delivery`;

  return { isDesynced: true, severity, reason };
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

const WAREHOUSES_STOCK_QUERY = `
query($cursor: String) {
  warehouses(first: 25, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        stocks(first: 100) {
          edges { node { quantity quantityAllocated productVariant { id sku } } }
        }
      }
    }
  }
}`;

const WEBHOOK_DELIVERIES_QUERY = `
query($webhookId: ID!, $after: String) {
  webhook(id: $webhookId) {
    eventDeliveries(first: 100, after: $after,
                     filter: { eventType: PRODUCT_VARIANT_STOCK_UPDATED }) {
      pageInfo { hasNextPage endCursor }
      edges { node { eventType createdAt payload status } }
    }
  }
}`;

const RECENT_ORDERS_QUERY = `
query($cursor: String, $since: DateTime) {
  orders(first: 50, after: $cursor,
         filter: { updatedAt: { gte: $since } }) {
    pageInfo { hasNextPage endCursor }
    edges { node { id status fulfillments { id } } }
  }
}`;

const STOCK_BULK_UPDATE = `
mutation($variantId: ID!, $warehouseId: ID!, $quantity: Int!) {
  stockBulkUpdate(stocks: [{ variantId: $variantId, warehouseId: $warehouseId, quantity: $quantity }]) {
    results { stock { id quantity } errors { field message code } }
  }
}`;

async function stockSnapshot() {
  let cursor = null;
  const rows = {};
  while (true) {
    const data = (await gql(WAREHOUSES_STOCK_QUERY, { cursor })).warehouses;
    for (const edge of data.edges) {
      const wh = edge.node;
      for (const stockEdge of wh.stocks.edges) {
        const stock = stockEdge.node;
        const key = `${stock.productVariant.id}::${wh.id}`;
        rows[key] = {
          variantId: stock.productVariant.id,
          warehouseId: wh.id,
          quantity: stock.quantity,
          quantityAllocated: stock.quantityAllocated,
        };
      }
    }
    if (!data.pageInfo.hasNextPage) return rows;
    cursor = data.pageInfo.endCursor;
  }
}

export function diffSnapshots(previous, current) {
  const deltas = [];
  for (const [key, curr] of Object.entries(current)) {
    const prev = previous[key];
    const before = prev ? prev.quantity : curr.quantity;
    if (before !== curr.quantity) {
      deltas.push({
        variantId: curr.variantId,
        warehouseId: curr.warehouseId,
        quantityBefore: before,
        quantityAfter: curr.quantity,
      });
    }
  }
  return deltas;
}

async function deliveriesInWindow(webhookId, windowStartIso, windowEndIso) {
  if (!webhookId) return [];
  let cursor = null;
  const matches = [];
  while (true) {
    const data = (await gql(WEBHOOK_DELIVERIES_QUERY, { webhookId, after: cursor })).webhook;
    for (const edge of data.eventDeliveries.edges) {
      const node = edge.node;
      if (node.createdAt >= windowStartIso && node.createdAt <= windowEndIso) matches.push(node);
    }
    if (!data.eventDeliveries.pageInfo.hasNextPage) return matches;
    cursor = data.eventDeliveries.pageInfo.endCursor;
  }
}

export function hasMatchingDelivery(deliveries, variantId, warehouseId) {
  for (const delivery of deliveries) {
    let payload;
    try {
      payload = JSON.parse(delivery.payload);
    } catch {
      continue;
    }
    if (payload?.productVariant?.id === variantId && payload?.warehouse?.id === warehouseId) {
      return true;
    }
  }
  return false;
}

async function recentMutationHint(sinceIso) {
  let data;
  try {
    data = (await gql(RECENT_ORDERS_QUERY, { cursor: null, since: sinceIso })).orders;
  } catch {
    return "UNKNOWN";
  }
  for (const edge of data.edges) {
    const node = edge.node;
    if (node.status === "CANCELED") return "ORDER_CANCEL";
    if (node.fulfillments.length) return "ORDER_FULFILL";
  }
  return "UNKNOWN";
}

async function reconcileExternal(record) {
  if (!RECONCILE_ENDPOINT) {
    console.log("No RECONCILE_ENDPOINT configured, skipping external POST.");
    return;
  }
  const payload = {
    productVariant: { id: record.variantId },
    warehouse: { id: record.warehouseId },
    quantity: record.quantityAfter,
    quantityAllocated: record.quantityAllocated,
  };
  if (DRY_RUN) {
    console.log("Would POST reconciliation payload:", payload);
    return;
  }
  const res = await fetch(RECONCILE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Reconcile endpoint ${res.status}`);
}

export async function run(previousSnapshot = {}) {
  const currentSnapshot = await stockSnapshot();
  const deltas = diffSnapshots(previousSnapshot, currentSnapshot);

  const nowIso = new Date().toISOString();
  const windowStartIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const deliveries = await deliveriesInWindow(WEBHOOK_ID, windowStartIso, nowIso);
  const hint = await recentMutationHint(windowStartIso);

  const flagged = [];
  for (const delta of deltas) {
    const found = hasMatchingDelivery(deliveries, delta.variantId, delta.warehouseId);
    const record = { ...delta, matchingDeliveryFound: found, recentMutationHint: hint };
    const result = classifyStockDesync(record);
    if (!result.isDesynced) continue;
    flagged.push({ ...record, ...result });
    console.warn(
      `DESYNC severity=${result.severity} variant=${delta.variantId} warehouse=${delta.warehouseId} before=${delta.quantityBefore} after=${delta.quantityAfter} reason=${result.reason}`
    );
  }

  for (const record of flagged) {
    await reconcileExternal(record);
  }

  console.log(`Done. ${flagged.length} desynced pair(s) ${DRY_RUN ? "would reconcile" : "reconciled"}.`);
  return { currentSnapshot, flagged };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
