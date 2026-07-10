/**
 * Flag Saleor SKUs that were double sold because duplicate, non-atomic stock
 * checks at checkoutCreate, checkoutLinesAdd, checkoutShippingAddressUpdate, and
 * checkoutComplete let two concurrent checkouts both pass.
 *
 * Report only. Never edits stock or cancels an order. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/duplicate-stock-checks-allow-oversell/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const ORDER_WINDOW_DAYS = Number(process.env.ORDER_WINDOW_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CANCELLED_STATUSES = new Set(["CANCELED", "CANCELLED"]);

export function findOversoldLines(orders, stocks) {
  const recomputed = new Map();
  const offenders = new Map();

  for (const order of orders) {
    if (CANCELLED_STATUSES.has((order.status || "").toUpperCase())) continue;
    for (const line of order.lines) {
      const key = `${line.sku}::${line.warehouse_id}`;
      recomputed.set(key, (recomputed.get(key) || 0) + line.allocated_qty);
      if (!offenders.has(key)) offenders.set(key, new Set());
      offenders.get(key).add(order.order_id);
    }
  }

  const results = [];
  for (const stock of stocks) {
    const key = `${stock.sku}::${stock.warehouse_id}`;
    const recomputedQty = recomputed.get(key) || 0;
    const onHand = stock.on_hand_qty;
    const reported = stock.reported_allocated_qty;
    const oversoldByStock = recomputedQty - onHand;
    const mismatched = recomputedQty !== reported;
    if (oversoldByStock > 0 || mismatched) {
      results.push({
        sku: stock.sku,
        warehouse_id: stock.warehouse_id,
        on_hand_qty: onHand,
        recomputed_allocated_qty: recomputedQty,
        reported_allocated_qty: reported,
        oversold_by: Math.max(oversoldByStock, 0),
        offending_order_ids: [...(offenders.get(key) || [])].sort(),
      });
    }
  }
  return results;
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

const ORDERS_QUERY = `
query($cursor: String, $createdGte: DateTime!) {
  orders(first: 100, after: $cursor, filter: { created: { gte: $createdGte } }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        lines {
          id
          productVariant { id sku }
          quantity
          quantityFulfilled
          allocations { id quantity warehouse { id name } }
        }
      }
    }
  }
}`;

const WAREHOUSES_QUERY = `
query($cursor: String) {
  warehouses(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        stocks {
          id
          quantity
          quantityAllocated
          productVariant { id sku }
        }
      }
    }
  }
}`;

async function* recentOrders(createdGteIso) {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { cursor, createdGte: createdGteIso })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function* allWarehouseStocks() {
  let cursor = null;
  while (true) {
    const data = (await gql(WAREHOUSES_QUERY, { cursor })).warehouses;
    for (const edge of data.edges) {
      const warehouse = edge.node;
      for (const stock of warehouse.stocks) {
        yield [warehouse.id, warehouse.name, stock];
      }
    }
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function flattenOrders() {
  const createdGte = new Date(Date.now() - ORDER_WINDOW_DAYS * 86400 * 1000).toISOString();
  const flat = [];
  for await (const order of recentOrders(createdGte)) {
    const lines = [];
    for (const line of order.lines) {
      const sku = line.productVariant?.sku;
      if (!sku) continue;
      for (const allocation of line.allocations || []) {
        lines.push({ sku, warehouse_id: allocation.warehouse.id, allocated_qty: allocation.quantity });
      }
    }
    flat.push({ order_id: order.id, status: order.status, lines });
  }
  return flat;
}

async function flattenStocks() {
  const flat = [];
  for await (const [warehouseId, , stock] of allWarehouseStocks()) {
    const sku = stock.productVariant?.sku;
    if (!sku) continue;
    flat.push({
      sku,
      warehouse_id: warehouseId,
      on_hand_qty: stock.quantity,
      reported_allocated_qty: stock.quantityAllocated,
    });
  }
  return flat;
}

export async function run() {
  const mode = DRY_RUN ? "dry run" : "live";
  console.log(`Scanning orders from the last ${ORDER_WINDOW_DAYS} day(s) (${mode}, report only)`);
  const orders = await flattenOrders();
  const stocks = await flattenStocks();
  const oversold = findOversoldLines(orders, stocks);
  for (const row of oversold) {
    console.warn(
      `OVERSOLD sku=${row.sku} warehouse=${row.warehouse_id} on_hand=${row.on_hand_qty} ` +
      `recomputed_allocated=${row.recomputed_allocated_qty} reported_allocated=${row.reported_allocated_qty} ` +
      `oversold_by=${row.oversold_by} orders=${row.offending_order_ids.join(",")}`
    );
  }
  console.log(`Done. ${oversold.length} SKU/warehouse pair(s) flagged. No stock or orders were changed.`);
  return oversold;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
