/**
 * Flag Saleor orders that are paid but still UNFULFILLED because nothing
 * ever called orderFulfill, because order.status is driven only by whether a
 * Fulfillment record exists, completely decoupled from isPaid or paymentStatus
 * (see saleor/saleor#4794, the Order object docs, and the OrderFilterInput docs).
 *
 * This script never calls orderFulfill by default. Under DRY_RUN=true (the
 * default) it only logs a report entry for each stuck order for staff triage.
 * The guarded auto-repair path (fulfillOrder) is opt-in only, meant for a
 * narrow, explicitly configured scenario, and should only ever run with fresh
 * stock data and DRY_RUN=false. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/order-stuck-unfulfilled-after-payment/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const STALE_AFTER_MINUTES = Number(process.env.STALE_AFTER_MINUTES || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_CHARGE_STATUSES = new Set(["FULLY_CHARGED", "PARTIALLY_CHARGED"]);

/**
 * Pure decision logic, no I/O.
 *
 * 1. If status is not UNFULFILLED, the order already moved on (or was
 *    cancelled), so it is not stuck.
 * 2. If it is not paid (isPaid true or a charged paymentChargeStatus), it is
 *    correctly waiting on payment, not stuck.
 * 3. If it already has an active (non-cancelled) fulfillment, the status
 *    field just has not recomputed yet, a separate bug class, not this one.
 * 4. If it has not aged past staleMinutes, it is still inside the normal
 *    staff-processing window.
 * 5. Otherwise it is genuinely stuck.
 */
export function classifyStuckOrder({ status, isPaid, paymentChargeStatus, fulfillments,
                                      updatedAtIso, nowIso, staleMinutes = 30 }) {
  if (status !== "UNFULFILLED") return { stuck: false, reason: "not_unfulfilled" };

  const paid = isPaid === true || PAID_CHARGE_STATUSES.has(paymentChargeStatus);
  if (!paid) return { stuck: false, reason: "not_paid" };

  const activeFulfillments = (fulfillments || []).filter((f) => f.status !== "CANCELED");
  if (activeFulfillments.length > 0) return { stuck: false, reason: "has_active_fulfillment" };

  const ageMinutes = (new Date(nowIso).getTime() - new Date(updatedAtIso).getTime()) / 60000;
  if (ageMinutes < staleMinutes) return { stuck: false, reason: "within_processing_window" };

  return { stuck: true, reason: "paid_but_no_fulfillment_past_threshold" };
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
  orders(first: 50, after: $cursor, sortBy: { field: CREATION_DATE, direction: ASC }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        isPaid
        paymentStatus
        channel { slug }
        total { gross { amount currency } }
        totalCharged { amount }
        created
        updatedAt
        fulfillments { id status }
      }
    }
  }
}`;

// Optional, opt-in only. Not called by the default flag-and-report flow.
const ORDER_FULFILL = `
mutation($order: ID!, $input: OrderFulfillInput!) {
  orderFulfill(order: $order, input: $input) {
    fulfillments { id status }
    errors { field code message }
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

// Opt-in only. Never called by run(). Wire in yourself for a narrow,
// explicitly configured scenario (for example digital or gift-card-only
// orders), always with fresh stock data pulled just before the call, and
// only when DRY_RUN=false.
export async function fulfillOrder(orderId, lines) {
  const result = (await gql(ORDER_FULFILL, { order: orderId, input: { lines, notifyCustomer: true } })).orderFulfill;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.fulfillments;
}

function toPlain(node) {
  return {
    id: node.id,
    number: node.number,
    status: node.status,
    isPaid: node.isPaid,
    paymentStatus: node.paymentStatus,
    channel: node.channel?.slug ?? null,
    paidAmount: node.totalCharged?.amount ?? null,
    updatedAtIso: node.updatedAt,
  };
}

export async function run() {
  const nowIso = new Date().toISOString();
  let flagged = 0;

  for await (const node of allOrders()) {
    const order = toPlain(node);
    const decision = classifyStuckOrder({
      status: order.status,
      isPaid: order.isPaid,
      paymentChargeStatus: order.paymentStatus,
      fulfillments: node.fulfillments,
      updatedAtIso: order.updatedAtIso,
      nowIso,
      staleMinutes: STALE_AFTER_MINUTES,
    });
    if (!decision.stuck) continue;

    const ageMinutes = (new Date(nowIso).getTime() - new Date(order.updatedAtIso).getTime()) / 60000;
    const reportEntry = {
      orderId: order.id,
      number: order.number,
      channel: order.channel,
      paidAmount: order.paidAmount,
      ageMinutes: Math.round(ageMinutes * 10) / 10,
    };
    console.warn("Stuck order found.", reportEntry, DRY_RUN ? "(dry run, reporting only)" : "(reporting only)");
    flagged++;
  }

  console.log(`Done. ${flagged} stuck order(s) flagged for staff triage.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
