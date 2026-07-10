/**
 * Find Saleor variant and warehouse pairs where Stock.quantity does not
 * match reality: either live Allocation rows exceed it, a known physical
 * count from a WMS export is higher than it, or it is zero while open
 * allocations exist (saleor/saleor#5578, #4058, #543).
 *
 * This script never overwrites inventory on its own. Under DRY_RUN=true
 * (the default) it only reports drifted pairs. When DRY_RUN=false and a
 * confirmed physical count is supplied per variant and warehouse, it
 * applies the correction one pair at a time and re-checks quantityAvailable
 * before moving on. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/stock-quantity-zero-despite-inventory/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const CHANNEL = process.env.SALEOR_CHANNEL || "default-channel";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function: no network calls.
 *
 * stock: {quantity, quantityAllocated, variantId, warehouseId}
 * allocations: [{quantity}, ...]
 * knownPhysicalCount: number | null
 *
 * Returns {isDrift, delta, reason} where reason is one of
 * "allocated_exceeds_quantity", "quantity_below_known_physical_count",
 * or "zero_quantity_with_open_allocations".
 */
export function detectStockDrift(stock, allocations, knownPhysicalCount = null) {
  const allocatedSum = allocations.reduce((sum, a) => sum + a.quantity, 0);
  const quantity = stock.quantity;

  if (quantity === 0 && allocatedSum > 0) {
    return { isDrift: true, delta: allocatedSum, reason: "zero_quantity_with_open_allocations" };
  }

  if (allocatedSum > quantity) {
    return { isDrift: true, delta: allocatedSum - quantity, reason: "allocated_exceeds_quantity" };
  }

  if (knownPhysicalCount !== null && knownPhysicalCount > quantity) {
    return { isDrift: true, delta: knownPhysicalCount - quantity, reason: "quantity_below_known_physical_count" };
  }

  return { isDrift: false, delta: 0, reason: "" };
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

const WAREHOUSES_QUERY = `
query($cursor: String) {
  warehouses(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name slug } }
  }
}`;

const VARIANTS_QUERY = `
query($channel: String!, $cursor: String) {
  productVariants(channel: $channel, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        quantityAvailable(countryCode: US)
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

const STOCK_BULK_UPDATE = `
mutation($variantId: ID!, $warehouseId: ID!, $quantity: Int!) {
  stockBulkUpdate(stocks: [{ variantId: $variantId, warehouseId: $warehouseId, quantity: $quantity }]) {
    results { stock { id quantity } errors { field message code } }
  }
}`;

const VARIANT_AVAILABILITY_QUERY = `
query($id: ID!, $channel: String!) {
  productVariant(id: $id, channel: $channel) { id quantityAvailable(countryCode: US) }
}`;

async function allWarehouses() {
  let cursor = null;
  const rows = [];
  while (true) {
    const data = (await gql(WAREHOUSES_QUERY, { cursor })).warehouses;
    rows.push(...data.edges.map((edge) => edge.node));
    if (!data.pageInfo.hasNextPage) return rows;
    cursor = data.pageInfo.endCursor;
  }
}

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
          quantity: stock.quantity,
          quantityAllocated: stock.quantityAllocated,
        });
      }
    }
    if (!data.pageInfo.hasNextPage) return rows;
    cursor = data.pageInfo.endCursor;
  }
}

async function allocationsFor(variantId, warehouseId) {
  let cursor = null;
  const matches = [];
  while (true) {
    const data = (await gql(ORDERS_WITH_ALLOCATIONS_QUERY, { cursor })).orders;
    for (const edge of data.edges) {
      for (const line of edge.node.lines) {
        if (!line.variant || line.variant.id !== variantId) continue;
        for (const allocation of line.allocations) {
          if (allocation.warehouse.id === warehouseId) matches.push({ quantity: allocation.quantity });
        }
      }
    }
    if (!data.pageInfo.hasNextPage) return matches;
    cursor = data.pageInfo.endCursor;
  }
}

async function applyCorrection(variantId, warehouseId, correctedQuantity) {
  const result = (await gql(STOCK_BULK_UPDATE, {
    variantId, warehouseId, quantity: correctedQuantity,
  })).stockBulkUpdate;
  for (const item of result.results) {
    if (item.errors.length) throw new Error(JSON.stringify(item.errors));
  }
  return result;
}

async function confirmAvailable(variantId, channel) {
  const data = (await gql(VARIANT_AVAILABILITY_QUERY, { id: variantId, channel })).productVariant;
  return data.quantityAvailable;
}

export async function run(knownPhysicalCounts = {}) {
  const stocks = await stockSnapshot(CHANNEL);
  const flagged = [];

  for (const stock of stocks) {
    const allocations = await allocationsFor(stock.variantId, stock.warehouseId);
    const known = knownPhysicalCounts[`${stock.variantId}::${stock.warehouseId}`] ?? null;
    const result = detectStockDrift(stock, allocations, known);
    if (!result.isDrift) continue;
    flagged.push({ ...stock, ...result, suspectedPhysicalCount: known });
    console.warn(
      `DRIFT sku=${stock.sku} variant=${stock.variantId} warehouse=${stock.warehouseId} quantity=${stock.quantity} allocated=${stock.quantityAllocated} reason=${result.reason} delta=${result.delta}`
    );
  }

  if (DRY_RUN) {
    console.log(`Done (dry run). ${flagged.length} drifted variant and warehouse pair(s) reported.`);
    return flagged;
  }

  for (const row of flagged) {
    if (row.suspectedPhysicalCount === null) {
      console.log(`Skipping ${row.sku} at ${row.warehouseId}, no confirmed physical count supplied.`);
      continue;
    }
    await applyCorrection(row.variantId, row.warehouseId, row.suspectedPhysicalCount);
    const available = await confirmAvailable(row.variantId, CHANNEL);
    console.log(`Corrected ${row.sku} at ${row.warehouseId} to ${row.suspectedPhysicalCount}. quantityAvailable now ${available}.`);
  }

  console.log(`Done. ${flagged.length} drifted variant and warehouse pair(s) processed.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
