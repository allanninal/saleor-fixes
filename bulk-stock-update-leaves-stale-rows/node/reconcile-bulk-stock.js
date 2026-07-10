/**
 * Find Saleor bulk stock update rows that stayed stale or partial after
 * productVariantStocksUpdate or stockBulkUpdate ran.
 *
 * Saleor's bulk stock mutations process a list of per-warehouse rows in one
 * call, but error handling is row-scoped via an errorPolicy. The default
 * REJECT_EVERYTHING rolls back the entire batch on any single bad row
 * (saleor/saleor#6479). REJECT_FAILED_ROWS and IGNORE_FAILED_ROWS instead
 * persist only the valid rows on purpose. A script that assumes the whole
 * batch always lands can end up with Stock rows still on their old
 * quantity, and concurrent writers can make a row look stale even after a
 * real success (saleor/saleor#5578).
 *
 * This script never blind-writes over a mismatch. Under DRY_RUN=true (the
 * default) it only reports the reconciliation diff. When DRY_RUN=false it
 * re-issues a new, scoped stockBulkUpdate for just the rows whose mismatch
 * a genuine failed-row error explains, never the original batch, then
 * re-reads and re-diffs to confirm convergence. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/bulk-stock-update-leaves-stale-rows/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REPAIRABLE_CODES = new Set(["NOT_FOUND", "INVALID"]);

function key(variantId, warehouseId) {
  return `${variantId}:${warehouseId}`;
}

/**
 * Pure decision function. No I/O.
 *
 * intended: [{variantId, warehouseId, quantity}]
 * actual: [{variantId, warehouseId, quantity}]
 * mutationErrors: [{variantId, warehouseId, code}]
 *
 * Returns one entry per intended row:
 * {variantId, warehouseId, intendedQuantity, actualQuantity, status}
 * where status is one of "ok", "stale", "reported_error".
 */
export function diffStockRows(intended, actual, mutationErrors) {
  const actualByKey = new Map(actual.map((r) => [key(r.variantId, r.warehouseId), r.quantity]));
  const errorKeys = new Set(mutationErrors.map((e) => key(e.variantId, e.warehouseId)));

  return intended.map((row) => {
    const k = key(row.variantId, row.warehouseId);
    const actualQuantity = actualByKey.has(k) ? actualByKey.get(k) : null;

    let status;
    if (errorKeys.has(k)) {
      status = "reported_error";
    } else if (actualQuantity === null || actualQuantity !== row.quantity) {
      status = "stale";
    } else {
      status = "ok";
    }

    return {
      variantId: row.variantId,
      warehouseId: row.warehouseId,
      intendedQuantity: row.quantity,
      actualQuantity,
      status,
    };
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

const VARIANT_STOCKS_QUERY = `
query($ids: [ID!]!) {
  productVariants(first: 100, filter: { ids: $ids }) {
    edges {
      node {
        id
        sku
        stocks { quantity quantityAllocated warehouse { id name } }
      }
    }
  }
}`;

const STOCK_BULK_UPDATE = `
mutation($stocks: [StockBulkUpdateInput!]!) {
  stockBulkUpdate(stocks: $stocks, errorPolicy: REJECT_FAILED_ROWS) {
    results {
      stock { id quantity productVariant { id } warehouse { id } }
      errors { field message code }
    }
    count
  }
}`;

async function actualStockRows(variantIds) {
  const data = (await gql(VARIANT_STOCKS_QUERY, { ids: variantIds })).productVariants;
  const rows = [];
  for (const edge of data.edges) {
    const node = edge.node;
    for (const stock of node.stocks) {
      rows.push({
        variantId: node.id,
        sku: node.sku,
        warehouseId: stock.warehouse.id,
        quantity: stock.quantity,
      });
    }
  }
  return rows;
}

async function runBulkUpdate(rows) {
  const stocksInput = rows.map((r) => ({
    variantId: r.variantId,
    warehouseId: r.warehouseId,
    quantity: r.quantity,
  }));
  const result = (await gql(STOCK_BULK_UPDATE, { stocks: stocksInput })).stockBulkUpdate;
  const mutationErrors = [];
  result.results.forEach((rowResult, i) => {
    for (const err of rowResult.errors || []) {
      mutationErrors.push({
        variantId: rows[i].variantId,
        warehouseId: rows[i].warehouseId,
        code: err.code,
      });
    }
  });
  return mutationErrors;
}

export async function run(intendedRows, mutationErrors = []) {
  const variantIds = [...new Set(intendedRows.map((r) => r.variantId))].sort();
  const actual = await actualStockRows(variantIds);

  const diffs = diffStockRows(intendedRows, actual, mutationErrors);
  const stale = diffs.filter((d) => d.status === "stale");

  for (const d of diffs) {
    if (d.status !== "ok") {
      console.warn(
        `${d.status} variant=${d.variantId} warehouse=${d.warehouseId} intended=${d.intendedQuantity} actual=${d.actualQuantity}`
      );
    }
  }

  const repairable = stale.filter((d) =>
    mutationErrors.some(
      (e) => e.variantId === d.variantId && e.warehouseId === d.warehouseId && REPAIRABLE_CODES.has(e.code)
    )
  );

  if (!repairable.length) {
    console.log(`Done. ${stale.length} stale row(s) reported, none auto-repairable.`);
    return diffs;
  }

  console.log(`${repairable.length} stale row(s) explained by a repairable error. ${DRY_RUN ? "would repair" : "repairing"}`);

  if (DRY_RUN) return diffs;

  const repairRows = repairable.map((d) => ({
    variantId: d.variantId,
    warehouseId: d.warehouseId,
    quantity: d.intendedQuantity,
  }));
  await runBulkUpdate(repairRows);

  const confirmActual = await actualStockRows(variantIds);
  const confirmDiffs = diffStockRows(intendedRows, confirmActual, []);
  const stillStale = confirmDiffs.filter((d) => d.status === "stale");
  console.log(`Repair done. ${stillStale.length} row(s) still stale after re-diff.`);
  return confirmDiffs;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run([]).catch((err) => { console.error(err); process.exit(1); });
}
