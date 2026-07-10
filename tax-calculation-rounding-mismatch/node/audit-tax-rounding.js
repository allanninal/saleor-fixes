/**
 * Audit Saleor orders for tax calculation mismatches, using Saleor's own
 * per-line rounding rule rather than a naive rate times subtotal
 * recomputation.
 *
 * With the flat-rate tax strategy, Saleor rounds tax to the cent on each
 * order line independently, then sums those already-rounded line amounts,
 * plus shipping, into order.total and order.subtotal. It never sums exact
 * unrounded values first and rounds once at the end. Because
 * line.unitPrice is derived by dividing the rounded line.totalPrice by
 * quantity, high quantity, low unit price lines amplify the per-unit
 * rounding remainder, so the sum of correctly rounded lines can
 * legitimately differ from rate times subtotal by one or more cents. This
 * is documented, longstanding behavior (see saleor/saleor#6720), not a
 * bug, so this script never flags ordinary per-line rounding drift.
 *
 * Under DRY_RUN=true (the default) this script only reports flagged
 * orders, it never writes anything. A real aggregation bug looks
 * different: the sum of a line's own already-rounded tax plus shipping
 * tax disagreeing with order.total.tax, which points at cache or
 * denormalization drift. Even then, the safe corrective action is a
 * gated no-op line update to force Saleor's own recompute pipeline,
 * limited to small confirmed deltas, never a direct write to order
 * totals. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/tax-calculation-rounding-mismatch/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const AGGREGATION_FIX_THRESHOLD_CENTS = Number(process.env.AGGREGATION_FIX_THRESHOLD_CENTS || 5);

/**
 * Pure decision function. No I/O.
 *
 * Recomputes expected tax the way Saleor computes it for a single order
 * line (net total times tax rate, rounded to the currency's minor unit
 * with round-half-up), then compares to the actual tax amount with a
 * tolerance sized in cents. Returns { isMismatch, expectedTax, delta }.
 */
export function checkLineTax(totalNetAmount, taxRate, actualTaxAmount,
                              currencyExponent = 2, toleranceCents = 1) {
  const quantum = Math.pow(10, -currencyExponent);
  const expectedTax = roundHalfUp(totalNetAmount * taxRate, currencyExponent);
  const delta = round2(Math.abs(actualTaxAmount - expectedTax));
  const isMismatch = delta > round2(quantum * toleranceCents) + 1e-9;
  return { isMismatch, expectedTax, delta };
}

function roundHalfUp(value, exponent) {
  const factor = Math.pow(10, exponent);
  return Math.round((value * factor) + Number.EPSILON * Math.sign(value)) / factor;
}

function round2(value) {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * Pure function. Reconciles one order's lines and aggregate tax.
 *
 * Flags a line only when it drifts from Saleor's own rounding rule by
 * more than a tolerance sized for how many lines the order has (this
 * accounts for the legitimate compounding of per-line rounding).
 * Separately checks whether order.total.tax equals the sum of every
 * line's own already-rounded tax plus shipping tax; a disagreement there
 * is a real aggregation bug, not rounding drift.
 */
export function reconcileOrder(order) {
  const lineMismatches = [];
  for (const line of order.lines) {
    const totalNet = line.totalPrice.net.amount;
    const actualTax = line.totalPrice.tax.amount;
    const { isMismatch, expectedTax, delta } = checkLineTax(
      totalNet, line.taxRate, actualTax,
      2, Math.max(1, order.lines.length)
    );
    if (isMismatch) {
      lineMismatches.push({ lineId: line.id, actual: actualTax, expected: expectedTax, delta });
    }
  }

  let expectedOrderTax = order.lines.reduce((sum, l) => sum + l.totalPrice.tax.amount, 0);
  expectedOrderTax += order.shippingPrice.tax.amount;
  const actualOrderTax = order.total.tax.amount;
  const aggregationDelta = Math.round(Math.abs(actualOrderTax - expectedOrderTax) * 100) / 100;
  const aggregationBug = aggregationDelta > 0;

  return {
    orderId: order.id,
    orderNumber: order.number,
    lineMismatches,
    aggregationBug,
    aggregationDelta,
    actualOrderTax,
    expectedOrderTax: Math.round(expectedOrderTax * 100) / 100,
  };
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
  orders(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        total { tax { amount } net { amount } gross { amount } }
        subtotal { net { amount } gross { amount } }
        shippingPrice { tax { amount } net { amount } gross { amount } }
        lines {
          id
          quantity
          unitPrice { tax { amount } net { amount } gross { amount } }
          totalPrice { tax { amount } net { amount } gross { amount } }
          taxRate
        }
      }
    }
  }
}`;

// A no-op line update (same quantity) forces Saleor's TaxedMoney
// recalculation pipeline to run again, without writing any amount directly.
const FORCE_RECALC_MUTATION = `
mutation($orderId: ID!, $lineId: ID!, $quantity: Int!) {
  orderLineUpdate(id: $lineId, input: { quantity: $quantity }) {
    orderLine { id }
    errors { field message code }
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

async function forceRecalculate(orderId, lineId, quantity) {
  const result = (await gql(FORCE_RECALC_MUTATION, { orderId, lineId, quantity })).orderLineUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
}

export async function run() {
  let flagged = 0;
  let fixed = 0;

  for await (const order of allOrders()) {
    const result = reconcileOrder(order);
    if (!result.lineMismatches.length && !result.aggregationBug) continue;

    console.warn(`Tax reconciliation flagged order ${order.number}:`, result);
    flagged++;

    // Only a confirmed aggregation bug below the threshold is ever a
    // candidate for a gated, forced recompute. Line-level rounding drift is
    // expected arithmetic and is never auto-corrected.
    if (
      !DRY_RUN &&
      result.aggregationBug &&
      result.aggregationDelta <= AGGREGATION_FIX_THRESHOLD_CENTS / 100 &&
      order.lines.length
    ) {
      const firstLine = order.lines[0];
      console.log(
        `Forcing recompute on order ${order.number} via no-op line update (delta ${result.aggregationDelta.toFixed(2)}).`
      );
      await forceRecalculate(order.id, firstLine.id, firstLine.quantity);
      fixed++;
    } else if (result.aggregationBug) {
      console.error(
        `Order ${order.number} aggregation delta ${result.aggregationDelta.toFixed(2)} exceeds threshold. Escalating to manual finance review.`
      );
    }
  }

  console.log(`Done. ${flagged} order(s) flagged, ${fixed} recompute(s) triggered.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
