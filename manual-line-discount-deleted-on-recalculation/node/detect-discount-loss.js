/**
 * Detect Saleor order lines whose manual discount silently disappears when
 * the order's prices recalculate (saleor/saleor#4675).
 *
 * Draft and unconfirmed order prices are lazy: any mutation that touches
 * the order, adding a line, updating a line, changing the shipping address
 * or method, or applying a voucher, can trigger fetch_order_prices_if_expired,
 * which re-derives each line's unit price from the undiscounted price plus
 * whatever catalogue promotions and vouchers currently apply. A manual line
 * discount applied through orderLineDiscountUpdate is supposed to take
 * precedence over that, but if its flag was not carried through correctly,
 * the recalculation falls back to standard pricing and clears
 * unitDiscountValue and unitDiscountReason without any error.
 *
 * This script never blind-restores a discount. Under DRY_RUN=true (the
 * default) it only reports flagged order and line ids with their before and
 * after values. When DRY_RUN=false and a human has confirmed the loss is a
 * regression and not a legitimate price change, it re-applies the exact
 * captured discount with orderLineDiscountUpdate. Run on demand around any
 * mutation you suspect of triggering recalculation.
 *
 * Guide: https://www.allanninal.dev/saleor/manual-line-discount-deleted-on-recalculation/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. Takes two plain snapshot objects and returns a
 * decision record. No network or DB calls.
 *
 * before / after each have: unitDiscountValue (number), unitDiscountType
 * ('FIXED'|'PERCENTAGE'), unitDiscountReason (string|null),
 * unitPriceGrossAmount (number). after additionally carries
 * undiscountedUnitPriceGrossAmount, accepted but not required by the
 * decision itself.
 *
 * Returns { lost, shouldFlag, restoreInput }. lost is true when the line
 * had a manual discount before (positive value or a non-null reason) and
 * both the value and the reason are gone after. shouldFlag mirrors lost.
 * restoreInput is populated only when lost is true, using the fields
 * captured in `before`.
 */
export function decideDiscountLoss(before, after) {
  const hadDiscount = before.unitDiscountValue > 0 || Boolean(before.unitDiscountReason);
  const lostValue = after.unitDiscountValue === 0;
  const lostReason = !after.unitDiscountReason;

  const lost = hadDiscount && lostValue && lostReason;

  if (!lost) {
    return { lost: false, shouldFlag: false, restoreInput: null };
  }

  const restoreInput = {
    valueType: before.unitDiscountType,
    value: before.unitDiscountValue,
    reason: before.unitDiscountReason,
  };
  return { lost: true, shouldFlag: true, restoreInput };
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

const ORDER_LINES_QUERY = `
query($id: ID!) {
  order(id: $id) {
    id
    status
    lines {
      id
      productName
      unitDiscount { amount currency }
      unitDiscountType
      unitDiscountValue
      unitDiscountReason
      undiscountedUnitPrice { gross { amount } }
      unitPrice { gross { amount } }
      isPriceOverridden
    }
  }
}`;

const RESTORE_DISCOUNT_MUTATION = `
mutation($lineId: ID!, $input: OrderDiscountCommonInput!) {
  orderLineDiscountUpdate(orderLineId: $lineId, input: $input) {
    orderLine { id unitDiscountValue unitDiscountReason }
    errors { field code message }
  }
}`;

async function snapshotOrderLines(orderId) {
  const order = (await gql(ORDER_LINES_QUERY, { id: orderId })).order;
  const snapshot = {};
  for (const line of order.lines) {
    snapshot[line.id] = {
      productName: line.productName,
      unitDiscountType: line.unitDiscountType,
      unitDiscountValue: line.unitDiscountValue || 0,
      unitDiscountReason: line.unitDiscountReason,
      unitPriceGrossAmount: line.unitPrice.gross.amount,
      undiscountedUnitPriceGrossAmount: line.undiscountedUnitPrice.gross.amount,
    };
  }
  return snapshot;
}

function flagLosses(orderId, before, after) {
  const flagged = [];
  for (const [lineId, beforeLine] of Object.entries(before)) {
    const afterLine = after[lineId];
    if (!afterLine) continue;
    const decision = decideDiscountLoss(beforeLine, afterLine);
    if (decision.shouldFlag) {
      flagged.push({
        orderId,
        lineId,
        productName: beforeLine.productName,
        before: beforeLine,
        after: afterLine,
        restoreInput: decision.restoreInput,
      });
    }
  }
  return flagged;
}

async function restoreDiscount(lineId, restoreInput) {
  const result = (await gql(RESTORE_DISCOUNT_MUTATION, { lineId, input: restoreInput })).orderLineDiscountUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.orderLine;
}

/**
 * mutateFn is the caller-supplied function that performs the mutation
 * suspected of triggering recalculation, for example orderLinesCreate or
 * orderUpdate. It receives no arguments and its return value is ignored.
 */
export async function run(orderId, mutateFn) {
  const before = await snapshotOrderLines(orderId);
  await mutateFn();
  const after = await snapshotOrderLines(orderId);

  const flagged = flagLosses(orderId, before, after);

  for (const item of flagged) {
    console.warn(
      `Order ${item.orderId} line ${item.lineId} (${item.productName}) lost its manual discount. before=${item.before.unitDiscountValue} after=${item.after.unitDiscountValue}`
    );
    if (!DRY_RUN) {
      await restoreDiscount(item.lineId, item.restoreInput);
      console.log(`Restored discount on line ${item.lineId}.`);
    }
  }

  console.log(`Done. ${flagged.length} line(s) flagged for a lost manual discount.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.env.ORDER_ID || "", async () => {}).catch((err) => { console.error(err); process.exit(1); });
}
