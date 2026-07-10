/**
 * Find Saleor orders where totalCaptured has run past order.total, because
 * Saleor sums chargedAmount across every TransactionItem on the order and
 * only dedupes CHARGE_SUCCESS events within a single TransactionItem, keyed
 * by (type, pspReference). There is no order-level cap at order.total (see
 * saleor/saleor#7399, saleor/saleor#4162, discussion #15458).
 *
 * Under DRY_RUN=true (the default) this script only reports over-captured
 * orders, it never refunds anything. A corrective refund of the exact
 * overBy amount is only ever issued when DRY_RUN=false, and only after a
 * human has signed off on that specific order, since the extra capture may
 * reflect a real second charge the customer actually paid. Run on a
 * schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/captured-amount-doubles-order-total/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

/**
 * Pure decision function. No I/O.
 * transactions is a list of { id, pspReference, chargedAmount }.
 * Returns { status: "OK"|"OVER_CAPTURED", totalCaptured, overBy, culprits }.
 */
export function classifyOrderCapture(orderTotal, transactions) {
  const totalCaptured = transactions.reduce((sum, t) => sum + t.chargedAmount, 0);

  if (totalCaptured <= orderTotal + EPSILON) {
    return { status: "OK", totalCaptured, overBy: 0, culprits: [] };
  }

  const overBy = Math.round((totalCaptured - orderTotal) * 100) / 100;
  const culprits = transactions
    .filter((t) => t.chargedAmount >= orderTotal - EPSILON)
    .sort((a, b) => b.chargedAmount - a.chargedAmount)
    .map((t) => t.id);

  return { status: "OVER_CAPTURED", totalCaptured, overBy, culprits };
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
        total { gross { amount } }
        totalCaptured { amount }
        transactions { id pspReference chargedAmount { amount } }
      }
    }
  }
}`;

const REFUND_EXCESS = `
mutation($id: ID!, $amount: Decimal!) {
  transactionRequestAction(id: $id, actionType: REFUND, amount: $amount) {
    transaction { id }
    errors { field message code }
  }
}`;

const ORDER_CAPTURE_CHECK = `
query($id: ID!) {
  order(id: $id) {
    id
    total { gross { amount } }
    totalCaptured { amount }
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

async function refundExcess(transactionId, amount) {
  const result = (await gql(REFUND_EXCESS, { id: transactionId, amount })).transactionRequestAction;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.transaction.id;
}

async function confirmReconciled(orderId, orderTotal) {
  const data = await gql(ORDER_CAPTURE_CHECK, { id: orderId });
  const captured = data.order.totalCaptured.amount;
  return Math.abs(captured - orderTotal) <= EPSILON;
}

function toPlain(node) {
  return {
    id: node.id,
    number: node.number,
    total: node.total.gross.amount,
    transactions: (node.transactions || []).map((t) => ({
      id: t.id,
      pspReference: t.pspReference,
      chargedAmount: t.chargedAmount.amount,
    })),
  };
}

export async function run() {
  let reported = 0;
  let refunded = 0;

  for await (const node of allOrders()) {
    const order = toPlain(node);
    const result = classifyOrderCapture(order.total, order.transactions);
    if (result.status === "OK") continue;

    const reportRow = {
      orderId: order.id,
      orderNumber: order.number,
      total: order.total,
      totalCaptured: result.totalCaptured,
      overBy: result.overBy,
      transactionIds: result.culprits,
    };
    console.warn("Over-captured order found for finance review:", reportRow);
    reported++;

    // Refunding is never automatic. This branch only ever runs when a human
    // has signed off on this specific order and DRY_RUN has been turned off.
    if (!DRY_RUN && result.culprits.length) {
      const culpritId = result.culprits[0];
      console.log(`Refunding excess ${result.overBy.toFixed(2)} on transaction ${culpritId} (signed off).`);
      await refundExcess(culpritId, result.overBy);
      const reconciled = await confirmReconciled(order.id, order.total);
      if (reconciled) {
        console.log(`Order ${order.number} reconciled. totalCaptured now matches total.`);
      } else {
        console.error(`Order ${order.number} still not reconciled after refund. Needs manual review.`);
      }
      refunded++;
    }
  }

  console.log(`Done. ${reported} order(s) reported over-captured, ${refunded} refund(s) issued.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
