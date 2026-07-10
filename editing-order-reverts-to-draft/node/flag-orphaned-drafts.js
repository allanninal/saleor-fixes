/**
 * Flag Saleor orders that were reverted to DRAFT by editing a confirmed
 * order, because the dashboard and API have historically reused draft-order
 * line and address mutations against placed orders, which can silently write
 * order.status back to DRAFT instead of rejecting the edit (see
 * saleor/saleor#4978, saleor/saleor#3987, and the order status docs).
 *
 * Because OrderStatusFilter has no DRAFT value, these orders are invisible to
 * any query filtered by status, so this script pages through every order with
 * no status filter and inspects the raw status field client-side.
 *
 * This script never calls draftOrderComplete or orderCancel by default. Under
 * DRY_RUN=true (the default) it only logs a report entry for each flagged
 * order for staff review. The guarded repair path (completeDraftOrder) is
 * opt-in only, meant to run after a human has reviewed the line and address
 * diff, and should only ever run with DRY_RUN=false. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/editing-order-reverts-to-draft/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function isOrphanedDraftWithPayment(order) {
  if (order.status !== "DRAFT") return false;

  const payments = order.payments || [];
  const hasChargedPayment = payments.some(
    (p) => p.isActive && p.chargeStatus !== "NOT_CHARGED"
  );
  const hasTransaction = (order.transactions || []).length > 0;

  return hasChargedPayment || hasTransaction;
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
        status
        created
        payments { id isActive chargeStatus }
        transactions { id }
      }
    }
  }
}`;

// Opt-in only. Not called by the default flag-and-report flow. Run only after
// a human has reviewed the line and address diff on the flagged order.
const DRAFT_ORDER_COMPLETE = `
mutation($id: ID!) {
  draftOrderComplete(id: $id) {
    order { id status }
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

// Opt-in only. Never called by run(). Wire in yourself only after a human has
// reviewed the line and address diff on the flagged order.
async function completeDraftOrder(orderId) {
  const result = (await gql(DRAFT_ORDER_COMPLETE, { id: orderId })).draftOrderComplete;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.order.status;
}

export async function run() {
  let flagged = 0;

  for await (const order of allOrders()) {
    if (!isOrphanedDraftWithPayment(order)) continue;

    const paymentIds = (order.payments || []).map((p) => p.id);
    const reportEntry = {
      orderId: order.id,
      number: order.number,
      paymentIds,
      transactionCount: (order.transactions || []).length,
    };
    console.warn("Orphaned draft order found.", reportEntry, DRY_RUN ? "(dry run, reporting only)" : "(reporting only)");
    flagged++;
  }

  console.log(`Done. ${flagged} orphaned draft order(s) flagged for staff review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
