/**
 * Detect Saleor draft orders whose voucher discount was dropped or shrunk by
 * draftOrderComplete's price recalculation, and report them for finance review.
 *
 * Saleor recalculates an order's prices through its pricing manager at several
 * trigger points, including the transition draftOrderComplete performs. The
 * discount is re-derived from the order's stored voucher and voucherCode
 * reference every time that recalculation runs, and that path has historically
 * failed to consistently re-derive it, dropping the OrderDiscount linkage or
 * recomputing it against the wrong base.
 *
 * There is no safe auto-fix: re-adding a discount after completion can desync
 * the order total from an already-captured Transaction or Payment. This is
 * detect and report, with an optional orderDiscountAdd call gated by DRY_RUN
 * and meant to run only after a human has reviewed the finding.
 *
 * Guide: https://www.allanninal.dev/saleor/draft-order-complete-drops-voucher/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function diffVoucherDiscount(draftSnapshot, completedSnapshot, tolerance = 0.01) {
  const expectedDiscount = draftSnapshot.undiscountedTotalGross - draftSnapshot.totalGross;
  const actualDiscount = completedSnapshot.undiscountedTotalGross - completedSnapshot.totalGross;
  const delta = expectedDiscount - actualDiscount;

  const voucherWasRemoved = Boolean(draftSnapshot.voucherCode) && !completedSnapshot.voucherCode;
  const discountShrank = delta > tolerance;

  const isDropped =
    Boolean(draftSnapshot.voucherCode) &&
    expectedDiscount > tolerance &&
    (voucherWasRemoved || discountShrank);

  return { isDropped, expectedDiscount, actualDiscount, delta };
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

const ORDER_SNAPSHOT_QUERY = `
query($id: ID!) {
  order(id: $id) {
    id
    status
    voucherCode
    voucher { code }
    discounts { type valueType value amount { amount } }
    total { gross { amount } }
    undiscountedTotal { gross { amount } }
  }
}`;

const COMPLETE_MUTATION = `
mutation($id: ID!) {
  draftOrderComplete(id: $id) {
    order { id }
    errors { field message }
  }
}`;

const DISCOUNT_ADD_MUTATION = `
mutation($orderId: ID!, $value: PositiveDecimal!, $reason: String!) {
  orderDiscountAdd(orderId: $orderId, input: { valueType: FIXED, value: $value, reason: $reason }) {
    order { id }
    errors { field message }
  }
}`;

async function fetchOrderSnapshot(orderId) {
  const { order } = await gql(ORDER_SNAPSHOT_QUERY, { id: orderId });
  return {
    voucherCode: order.voucherCode,
    totalGross: order.total.gross.amount,
    undiscountedTotalGross: order.undiscountedTotal.gross.amount,
  };
}

async function completeDraftOrder(draftId) {
  const result = (await gql(COMPLETE_MUTATION, { id: draftId })).draftOrderComplete;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.order.id;
}

async function recoverDiscount(orderId, expectedDiscount) {
  const result = (
    await gql(DISCOUNT_ADD_MUTATION, {
      orderId,
      value: Math.round(expectedDiscount * 100) / 100,
      reason: "Recovered voucher discount from draft order snapshot",
    })
  ).orderDiscountAdd;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.order.id;
}

export async function run(draftOrderIds) {
  const mode = DRY_RUN ? "dry run" : "live";
  console.log(`Checking ${draftOrderIds.length} draft order(s) for dropped vouchers (${mode})`);

  let flagged = 0;
  for (const draftId of draftOrderIds) {
    const draftSnapshot = await fetchOrderSnapshot(draftId);
    const completedId = await completeDraftOrder(draftId);
    const completedSnapshot = await fetchOrderSnapshot(completedId);

    const result = diffVoucherDiscount(draftSnapshot, completedSnapshot);
    if (!result.isDropped) continue;

    flagged++;
    console.warn(
      `Voucher dropped on order=${completedId} expected=${result.expectedDiscount.toFixed(2)} actual=${result.actualDiscount.toFixed(2)} delta=${result.delta.toFixed(2)}`
    );

    if (!DRY_RUN) await recoverDiscount(completedId, result.expectedDiscount);
  }

  console.log(
    `Done. ${flagged} order(s) with a dropped voucher ${DRY_RUN ? "to review" : "had a discount re-added"}.`
  );
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run([]).catch((err) => { console.error(err); process.exit(1); });
}
