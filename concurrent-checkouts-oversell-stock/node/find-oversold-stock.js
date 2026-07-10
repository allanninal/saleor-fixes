/**
 * Find Saleor variant and warehouse pairs where quantityAllocated exceeds quantity.
 *
 * Concurrent checkouts can race through Saleor's check-then-allocate stock flow
 * (saleor/saleor#543) and both complete, leaving more stock allocated than exists.
 * This script never rewrites stock or cancels an order. It reports the oversold
 * pairs, the affected order IDs, and a suggested stockBulkUpdate payload for a
 * human to review. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/concurrent-checkouts-oversell-stock/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const CHANNEL = process.env.SALEOR_CHANNEL || "default-channel";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic. Takes an already-fetched stock snapshot array and
 * returns the oversold subset, sorted by delta descending, for the caller
 * to report. No I/O.
 */
export function findOversoldStocks(stocks) {
  return stocks
    .map((stock) => ({
      variantId: stock.variantId,
      sku: stock.sku,
      warehouseId: stock.warehouseId,
      delta: stock.quantityAllocated - stock.quantity,
    }))
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta);
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

const VARIANTS_QUERY = `
query($channel: String!, $cursor: String) {
  productVariants(channel: $channel, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        stocks { warehouse { id slug } quantity quantityAllocated }
      }
    }
  }
}`;

const ORDERS_WITH_ALLOCATIONS_QUERY = `
query($cursor: String) {
  orders(first: 50, after: $cursor,
         filter: { status: [UNFULFILLED, PARTIALLY_FULFILLED] }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        lines {
          variant { id sku }
          allocations { quantity warehouse { id } }
        }
      }
    }
  }
}`;

async function stockSnapshot(channel) {
  let cursor = null;
  const rows = [];
  while (true) {
    const data = (await gql(VARIANTS_QUERY, { channel, cursor })).productVariants;
    for (const edge of data.edges) {
      const node = edge.node;
      for (const stock of node.stocks) {
        rows.push({
          variantId: node.id,
          sku: node.sku,
          warehouseId: stock.warehouse.id,
          warehouseSlug: stock.warehouse.slug,
          quantity: stock.quantity,
          quantityAllocated: stock.quantityAllocated,
        });
      }
    }
    if (!data.pageInfo.hasNextPage) return rows;
    cursor = data.pageInfo.endCursor;
  }
}

async function ordersAllocatingVariant(variantId, warehouseId) {
  let cursor = null;
  const matches = [];
  while (true) {
    const data = (await gql(ORDERS_WITH_ALLOCATIONS_QUERY, { cursor })).orders;
    for (const edge of data.edges) {
      const order = edge.node;
      for (const line of order.lines) {
        if (!line.variant || line.variant.id !== variantId) continue;
        for (const allocation of line.allocations) {
          if (allocation.warehouse.id === warehouseId) matches.push(order.id);
        }
      }
    }
    if (!data.pageInfo.hasNextPage) return matches;
    cursor = data.pageInfo.endCursor;
  }
}

export async function run() {
  const stocks = await stockSnapshot(CHANNEL);
  const oversold = findOversoldStocks(stocks);
  if (oversold.length === 0) {
    console.log("Done. No oversold variant and warehouse pairs found.");
    return;
  }

  for (const row of oversold) {
    const affectedOrders = await ordersAllocatingVariant(row.variantId, row.warehouseId);
    console.warn(
      `OVERSOLD sku=${row.sku} variant=${row.variantId} warehouse=${row.warehouseId} delta=${row.delta} affected_orders=${JSON.stringify(affectedOrders)}`
    );
    const suggestedPayload = {
      stocks: [{
        variantId: row.variantId,
        warehouseId: row.warehouseId,
        quantity: "<corrected on-hand count from a physical recount>",
      }],
      errorPolicy: "REJECT_EVERYTHING",
    };
    console.log(
      `Suggested repair (${DRY_RUN ? "dry run" : "human review required"}, not applied automatically): ${JSON.stringify(suggestedPayload)}`
    );
  }
  console.log(`Done. ${oversold.length} oversold variant and warehouse pair(s) reported.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
