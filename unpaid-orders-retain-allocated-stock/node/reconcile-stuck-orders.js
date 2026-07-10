/**
 * Find Saleor orders that are old, unpaid, and still holding a stock
 * allocation nothing is going to release, because expireOrdersAfter defaults
 * to null and only ever covers UNCONFIRMED orders with no payment attached
 * (see saleor/saleor#11257, Order Expiration and Order Status docs).
 *
 * This script never cancels a partially fulfilled order. Under DRY_RUN=true
 * (the default) it only logs what it would do. When DRY_RUN=false, it calls
 * orderCancel for UNCONFIRMED or fully UNFULFILLED orders, which releases
 * every allocation on the order as a side effect. PARTIALLY_FULFILLED orders
 * are only ever flagged for a human, never auto-cancelled. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/unpaid-orders-retain-allocated-stock/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const STALE_AFTER_HOURS = Number(process.env.STALE_AFTER_HOURS || 72);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RESOLVED_STATUSES = new Set(["CANCELED", "EXPIRED", "FULFILLED"]);
const STUCK_STATUSES = new Set(["UNFULFILLED", "UNCONFIRMED", "PARTIALLY_FULFILLED"]);
const UNPAID_PAYMENT_STATUSES = new Set(["NOT_CHARGED", "REFUNDED", "VOIDED", "CANCELED"]);

/**
 * Pure decision function. order is a plain object shaped like:
 * { status, isPaid, paymentStatus, createdAt (ISO string or Date), channelExpireOrdersAfterMin }
 * Returns one of 'OK', 'CANCEL', 'DEALLOCATE_ONLY'.
 */
export function classifyStuckOrder(order, now, staleAfterHours) {
  if (RESOLVED_STATUSES.has(order.status) || order.isPaid) return "OK";

  const ageHours = (now.getTime() - new Date(order.createdAt).getTime()) / 3600000;

  const expireAfter = order.channelExpireOrdersAfterMin;
  if (order.status === "UNCONFIRMED" && expireAfter !== null && expireAfter !== undefined) {
    if (ageHours * 60 < expireAfter) return "OK"; // native expiration will still handle it
  }

  if (
    ageHours > staleAfterHours &&
    UNPAID_PAYMENT_STATUSES.has(order.paymentStatus) &&
    STUCK_STATUSES.has(order.status)
  ) {
    if (order.status === "PARTIALLY_FULFILLED") return "DEALLOCATE_ONLY";
    return "CANCEL"; // UNCONFIRMED or UNFULFILLED, nothing shipped
  }

  return "OK";
}

export function hasOpenAllocation(order) {
  return (order.lines || []).some((line) => line.quantity > line.quantityFulfilled);
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
        created
        channel { slug orderSettings { expireOrdersAfter } }
        lines { id quantity quantityFulfilled variant { id } }
      }
    }
  }
}`;

const ORDER_CANCEL = `
mutation($id: ID!) {
  orderCancel(id: $id) {
    order { id status }
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

async function cancelOrder(orderId) {
  const result = (await gql(ORDER_CANCEL, { id: orderId })).orderCancel;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.order.status;
}

function toPlain(node) {
  const settings = node.channel?.orderSettings || {};
  return {
    id: node.id,
    number: node.number,
    status: node.status,
    isPaid: node.isPaid,
    paymentStatus: node.paymentStatus,
    createdAt: node.created,
    channelExpireOrdersAfterMin: settings.expireOrdersAfter ?? null,
    lines: node.lines,
  };
}

export async function run() {
  const now = new Date();
  let cancelled = 0;
  let flagged = 0;

  for await (const node of allOrders()) {
    const order = toPlain(node);
    if (!hasOpenAllocation(order)) continue;

    const decision = classifyStuckOrder(order, now, STALE_AFTER_HOURS);
    if (decision === "OK") continue;

    console.log({
      orderId: order.id,
      number: order.number,
      previousStatus: order.status,
      action: decision === "CANCEL" ? "orderCancel" : "flag_for_review",
    });

    if (decision === "CANCEL") {
      if (!DRY_RUN) await cancelOrder(order.id);
      cancelled++;
    } else {
      flagged++;
    }
  }

  console.log(
    `Done. ${cancelled} order(s) ${DRY_RUN ? "to cancel" : "cancelled"}, ${flagged} order(s) flagged for human review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
