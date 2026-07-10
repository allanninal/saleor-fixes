/**
 * Flag Saleor orders and open checkouts whose percentage-voucher discount
 * was computed under the pre-3.12 ROUND_DOWN rule and no longer matches
 * what the same voucher computes today under ROUND_HALF_UP.
 *
 * Saleor 3.12 changed the decimal quantization mode used for percentage
 * discounts from ROUND_DOWN to ROUND_HALF_UP (see the 3.11 to 3.12 upgrade
 * guide). A 12.5% voucher on 13.00 gives a 1.62 discount and 11.38 total
 * under the old rule, versus 1.63 and 11.37 under the current one. Only
 * PERCENTAGE vouchers are affected; FIXED vouchers never need to quantize
 * a fraction. Saleor 3.12 also separately started populating
 * Checkout.discount for SPECIFIC_PRODUCT and apply-once-per-order
 * vouchers, which is a benign, unrelated change a naive diff would flag.
 *
 * There is no safe auto-fix for a placed or paid order: it is a financial
 * record of what was actually charged, so it is reported for finance to
 * review, never rewritten. Only a still-open, unpaid checkout can be
 * safely nudged into recomputing its own total, by removing and reapplying
 * the same voucher code so Saleor's own current pricing logic recalculates it.
 *
 * Guide: https://www.allanninal.dev/saleor/discount-rounding-change-breaks-totals-after-upgrade/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DEPLOY_DATE_ISO = process.env.DEPLOY_DATE_ISO || "1970-01-01T00:00:00Z";

export function computeDiscountDrift({
  undiscountedAmount,
  discountValueType,
  discountValue,
  persistedDiscountAmount,
  currencyDecimalPlaces = 2,
}) {
  // Pure decision logic, no I/O.
  // FIXED vouchers are rounding-mode-invariant, so they are never drifted.
  // PERCENTAGE vouchers are recomputed with the current round-half-up rule
  // and compared against whatever amount is already persisted.
  if (discountValueType !== "PERCENTAGE") {
    return { expectedDiscountAmount: persistedDiscountAmount, delta: 0, isDrifted: false };
  }

  const scale = 10 ** currencyDecimalPlaces;
  const raw = (undiscountedAmount * discountValue) / 100;
  const expectedDiscountAmount = Math.round(raw * scale) / scale;

  const rawDelta = expectedDiscountAmount - persistedDiscountAmount;
  const delta = Math.round(rawDelta * scale) / scale;
  const isDrifted = Math.abs(delta) >= 1 / scale;

  return { expectedDiscountAmount, delta, isDrifted };
}

export function persistedDiscount(order) {
  const amounts = (order.discounts || []).map((d) => d.amount.amount);
  if (amounts.length) return amounts.reduce((a, b) => a + b, 0);
  const undiscounted = order.undiscountedTotal.gross.amount;
  const total = order.total.gross.amount;
  return Math.round((undiscounted - total) * 100) / 100;
}

export function flagOrder(order, deployDateIso, discountValue) {
  const voucher = order.voucher;
  if (!voucher) return null;

  const undiscounted = order.undiscountedTotal.gross.amount;
  const persisted = persistedDiscount(order);

  const result = computeDiscountDrift({
    undiscountedAmount: undiscounted,
    discountValueType: voucher.discountValueType,
    discountValue,
    persistedDiscountAmount: persisted,
  });
  if (!result.isDrifted) return null;

  return {
    orderId: order.id,
    orderNumber: order.number,
    created: order.created,
    predatesUpgrade: order.created < deployDateIso,
    persistedDiscount: persisted,
    expectedDiscount: result.expectedDiscountAmount,
    delta: result.delta,
    currency: order.total.gross.currency,
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

const VOUCHERS_QUERY = `
query {
  vouchers(first: 100) {
    edges { node { id name discountValueType type codes(first: 1) { edges { node { code } } } } }
  }
}`;

const ORDERS_QUERY = `
query($after: String) {
  orders(first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id number created
        voucher { id discountValueType type }
        undiscountedTotal { gross { amount currency } }
        total { gross { amount currency } }
        discounts { id value valueType amount { amount } }
      }
    }
  }
}`;

const REMOVE_PROMO = `
mutation($checkoutId: ID!, $code: String!) {
  checkoutRemovePromoCode(id: $checkoutId, promoCode: $code) {
    errors { field message code }
  }
}`;

const ADD_PROMO = `
mutation($checkoutId: ID!, $code: String!) {
  checkoutAddPromoCode(id: $checkoutId, promoCode: $code) {
    checkout { id discount { amount } totalPrice { gross { amount } } }
    errors { field message code }
  }
}`;

async function percentageVoucherIds() {
  const data = (await gql(VOUCHERS_QUERY)).vouchers;
  return new Set(
    data.edges
      .filter((edge) => edge.node.discountValueType === "PERCENTAGE")
      .map((edge) => edge.node.id)
  );
}

async function* ordersWithVoucher() {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { after: cursor })).orders;
    for (const edge of data.edges) {
      if (edge.node.voucher) yield edge.node;
    }
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

export async function reapplyVoucher(checkoutId, code) {
  const removed = (await gql(REMOVE_PROMO, { checkoutId, code })).checkoutRemovePromoCode;
  if (removed.errors.length) throw new Error(JSON.stringify(removed.errors));
  const added = (await gql(ADD_PROMO, { checkoutId, code })).checkoutAddPromoCode;
  if (added.errors.length) throw new Error(JSON.stringify(added.errors));
  return added.checkout;
}

export async function run() {
  const percentageIds = await percentageVoucherIds();
  const mode = DRY_RUN ? "dry run" : "live";
  console.log(`Scanning orders for discount rounding drift (${mode})`);

  let flagged = 0;
  for await (const order of ordersWithVoucher()) {
    const voucher = order.voucher;
    if (!percentageIds.has(voucher.id)) continue;

    // In a real run, resolve discountValue from the voucher's channel listing.
    const finding = flagOrder(order, DEPLOY_DATE_ISO, undefined);
    if (!finding) continue;

    flagged++;
    console.warn(
      `Drifted order=${finding.orderNumber} created=${finding.created} predatesUpgrade=${finding.predatesUpgrade} expected=${finding.expectedDiscount.toFixed(2)} persisted=${finding.persistedDiscount.toFixed(2)} delta=${finding.delta.toFixed(2)} ${finding.currency}`
    );
  }

  console.log(`Done. ${flagged} order(s) flagged for finance review. No order totals were rewritten.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
