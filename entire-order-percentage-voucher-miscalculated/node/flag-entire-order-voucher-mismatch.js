/**
 * Flag Saleor orders where an ENTIRE_ORDER percentage voucher was calculated
 * against the wrong base amount, understating the discount when a line also
 * carried an active catalogue Promotion.
 *
 * Saleor's docs say an ENTIRE_ORDER voucher discount applies to the subtotal,
 * the sum of line prices after any catalogue promotion has already reduced
 * them. In affected versions the order-discount pipeline instead sourced its
 * base amount from the undiscounted total, so the voucher percentage and the
 * promotion percentage stacked additively instead of compounding. Tracked as
 * Saleor GitHub issue #17453, which also reported non-deterministic totals on
 * otherwise-identical orders.
 *
 * There is no safe auto-fix for a finalized order: Saleor has no mutation
 * that overwrites a stored total or discount directly, and orderUpdate does
 * not accept one. This is detect and report, run in DRY_RUN mode by default,
 * for finance and support to review before any correction is made by hand.
 *
 * Guide: https://www.allanninal.dev/saleor/entire-order-percentage-voucher-miscalculated/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const TOLERANCE = 0.01;

export function round2(value) {
  return Math.round((value + 1e-9) * 100) / 100;
}

export function computeExpectedEntireOrderPercentageDiscount(
  subtotalAmount,
  voucherDiscountValue,
  applyOncePerOrder,
  cheapestLineUnitPrice
) {
  // Pure decision logic, no I/O.
  // subtotalAmount MUST already reflect any catalogue-promotion line discounts,
  // never the undiscounted total, per the documented ENTIRE_ORDER semantics.
  let discount;
  if (applyOncePerOrder) {
    const base = cheapestLineUnitPrice || 0;
    discount = round2(base * (voucherDiscountValue / 100));
  } else {
    discount = round2(subtotalAmount * (voucherDiscountValue / 100));
  }
  return Math.min(discount, subtotalAmount);
}

export function actualVoucherDiscount(order) {
  const voucherAmounts = (order.discounts || [])
    .filter((d) => d.type === "VOUCHER")
    .map((d) => d.amount.amount);
  if (voucherAmounts.length) return voucherAmounts.reduce((a, b) => a + b, 0);
  const undiscounted = order.undiscountedTotal.gross.amount;
  const total = order.total.gross.amount;
  return round2(undiscounted - total);
}

export function hasStackedPromotionAndVoucher(order) {
  const lines = order.lines || [];
  return lines.some((line) => (line.unitDiscountAmount || 0) > 0);
}

export function flagOrder(order, applyOncePerOrder = false, cheapestLineUnitPrice) {
  const channelSlug = order.channel.slug;
  const listing = (order.voucher.channelListings || []).find(
    (c) => c.channel.slug === channelSlug
  );
  if (!listing) return null;

  const subtotal = order.subtotal.gross.amount;
  const expected = computeExpectedEntireOrderPercentageDiscount(
    subtotal, listing.discountValue, applyOncePerOrder, cheapestLineUnitPrice
  );
  const actual = actualVoucherDiscount(order);
  const delta = round2(actual - expected);

  if (Math.abs(delta) <= TOLERANCE) return null;

  return {
    orderId: order.id,
    orderNumber: order.number,
    expectedDiscount: expected,
    actualDiscount: actual,
    delta,
    channel: channelSlug,
    voucherCode: order.voucher.id,
    stackedWithPromotion: hasStackedPromotionAndVoucher(order),
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
        subtotal { gross { amount } }
        undiscountedTotal { gross { amount } }
        total { gross { amount } }
        channel { slug }
        voucher {
          id
          type
          discountValueType
          channelListings { channel { slug } discountValue }
        }
        discounts { type value valueType amount { amount } }
        lines {
          id
          unitDiscountAmount
          unitDiscountType
          undiscountedUnitPrice { gross { amount } }
        }
      }
    }
  }
}`;

async function* entireOrderVoucherOrders() {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { cursor })).orders;
    for (const edge of data.edges) {
      const node = edge.node;
      const voucher = node.voucher;
      if (voucher && voucher.type === "ENTIRE_ORDER" && voucher.discountValueType === "PERCENTAGE") {
        yield node;
      }
    }
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

export async function run() {
  const mode = DRY_RUN ? "dry run" : "live";
  console.log(`Scanning orders for entire order percentage voucher mismatches (${mode})`);

  let flagged = 0;
  for await (const order of entireOrderVoucherOrders()) {
    const finding = flagOrder(order);
    if (!finding) continue;

    flagged++;
    console.warn(
      `Mismatch on order=${finding.orderNumber} expected=${finding.expectedDiscount.toFixed(2)} actual=${finding.actualDiscount.toFixed(2)} delta=${finding.delta.toFixed(2)} channel=${finding.channel} stacked=${finding.stackedWithPromotion}`
    );
  }

  console.log(`Done. ${flagged} order(s) flagged for finance review.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
