/**
 * Flag Saleor orders where a downstream consumer recorded the wrong
 * subtotal basis, gross instead of net, or the reverse.
 *
 * Order.subtotal, Order.total, and every OrderLine.unitPrice and
 * totalPrice resolve to a TaxedMoney object that always carries both a
 * gross and a net amount together, computed per line from the channel's
 * TaxConfiguration (pricesEnteredWithTax, displayGrossPrices, chargeTaxes)
 * or a custom ORDER_CALCULATE_TAXES tax app webhook. The bug is not in
 * Saleor's stored data, both figures it returns are correct, it is in a
 * script, report, or migration that read subtotal.gross.amount as the
 * only subtotal while the channel's pricesEnteredWithTax convention and
 * the downstream ledger expect net (or the reverse). Because each line
 * can carry its own tax rate, the discrepancy equals the sum of per-line
 * tax, not a fixed percentage.
 *
 * Under DRY_RUN=true (the default) this script only reports flagged
 * orders, it never writes anything. There is nothing to repair inside
 * Saleor itself, so the only ever corrective action is to regenerate a
 * downstream export after a human confirms which figure is contractually
 * correct. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/order-subtotal-gross-instead-of-net/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SUBTOTAL_EPSILON = Number(process.env.SUBTOTAL_EPSILON || 0.01);

/**
 * Pure decision function. No I/O.
 *
 * order: { subtotalNet: number, subtotalGross: number,
 *          lines: Array<{ totalPriceNet: number, totalPriceGross: number }> }
 * taxConfig: { pricesEnteredWithTax: boolean }
 * recordedSubtotal: number, the figure a downstream consumer recorded for this order.
 *
 * Returns { isMismatch, expected, recorded, delta, expectedBasis }.
 */
export function decideSubtotalMismatch(order, taxConfig, recordedSubtotal, epsilon = 0.01) {
  const expectedBasis = taxConfig.pricesEnteredWithTax ? "net" : "gross";
  const key = expectedBasis === "net" ? "totalPriceNet" : "totalPriceGross";
  const expected = order.lines.reduce((sum, line) => sum + line[key], 0);
  const delta = Math.abs(expected - recordedSubtotal);
  const isMismatch = delta > epsilon;

  return { isMismatch, expected, recorded: recordedSubtotal, delta, expectedBasis };
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
query($cursor: String) {
  orders(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        channel { id slug taxConfiguration { pricesEnteredWithTax displayGrossPrices chargeTaxes } }
        subtotal { gross { amount currency } net { amount currency } tax { amount } }
        lines {
          id
          quantity
          unitPrice { gross { amount } net { amount } }
          totalPrice { gross { amount } net { amount } }
        }
      }
    }
  }
}`;

async function* allOrders() {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

function toPlainOrder(node) {
  const lines = node.lines.map((line) => ({
    totalPriceNet: line.totalPrice.net.amount,
    totalPriceGross: line.totalPrice.gross.amount,
  }));
  return {
    id: node.id,
    number: node.number,
    channelSlug: node.channel.slug,
    taxConfig: node.channel.taxConfiguration,
    subtotalNet: node.subtotal.net.amount,
    subtotalGross: node.subtotal.gross.amount,
    lines,
  };
}

function buildReportRow(order, recordedSubtotal) {
  const decision = decideSubtotalMismatch(order, order.taxConfig, recordedSubtotal, SUBTOTAL_EPSILON);
  if (!decision.isMismatch) return null;
  return {
    orderId: order.id,
    orderNumber: order.number,
    channelSlug: order.channelSlug,
    pricesEnteredWithTax: order.taxConfig.pricesEnteredWithTax,
    subtotalNet: order.subtotalNet,
    subtotalGross: order.subtotalGross,
    recordedSubtotal,
    expectedBasis: decision.expectedBasis,
    delta: Math.round(decision.delta * 100) / 100,
  };
}

/**
 * Stand-in for however your own pipeline recorded a subtotal downstream,
 * for example a prior CSV export, an ERP sync log, or a cached report row.
 * Wire this up to your real source. Left here it mirrors gross, which is
 * exactly the class of bug this script is built to catch.
 */
function recordedSubtotalFor(order) {
  return order.subtotalGross;
}

export async function run() {
  let flagged = 0;

  for await (const node of allOrders()) {
    const order = toPlainOrder(node);
    const recorded = recordedSubtotalFor(order);
    const row = buildReportRow(order, recorded);
    if (row === null) continue;

    console.warn("Subtotal basis mismatch found.", row);
    flagged++;
  }

  console.log(`Done. ${flagged} order(s) flagged for review.${DRY_RUN ? " (dry run)" : ""}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
