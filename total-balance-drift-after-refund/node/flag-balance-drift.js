/**
 * Find Saleor orders where totalBalance no longer reconciles with total,
 * totalCaptured, and totalRefunded, because totalBalance is derived at
 * read time from whatever TransactionItem events happen to exist, and a
 * partial refund or an authorization adjustment can update one field
 * without a matching correction to the others (see saleor/saleor#12297,
 * saleor/saleor#11445, discussion #15458).
 *
 * Under DRY_RUN=true (the default) this script only reports drifted
 * orders, it never writes a correcting event. A correction is only ever
 * recorded when DRY_RUN=false, and only after a human has signed off on
 * the specific transaction, event type, and amount, since the right fix
 * depends on reading the actual raw events. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/total-balance-drift-after-refund/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

/**
 * Pure decision function. No I/O.
 * All amounts are plain numbers, the same units Saleor reports them in.
 * Returns { status: "OK"|"BALANCE_DRIFTED", expectedBalance, reportedBalance, driftedBy }.
 */
export function classifyBalanceDrift(total, totalCaptured, totalRefunded, reportedBalance) {
  const expectedBalance = Math.round((total - totalCaptured + totalRefunded) * 100) / 100;
  const driftedBy = Math.round((reportedBalance - expectedBalance) * 100) / 100;

  if (Math.abs(driftedBy) <= EPSILON) {
    return { status: "OK", expectedBalance, reportedBalance, driftedBy: 0 };
  }

  return { status: "BALANCE_DRIFTED", expectedBalance, reportedBalance, driftedBy };
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
        totalRefunded { amount }
        totalBalance { amount }
      }
    }
  }
}`;

const REPORT_EVENT = `
mutation($id: ID!, $type: TransactionEventTypeEnum!, $amount: Decimal!) {
  transactionEventReport(id: $id, type: $type, amount: $amount) {
    transaction { id }
    errors { field message code }
  }
}`;

const ORDER_BALANCE_CHECK = `
query($id: ID!) {
  order(id: $id) {
    id
    total { gross { amount } }
    totalCaptured { amount }
    totalRefunded { amount }
    totalBalance { amount }
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

async function recordCorrectingEvent(transactionId, eventType, amount) {
  const result = (await gql(REPORT_EVENT, { id: transactionId, type: eventType, amount })).transactionEventReport;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.transaction.id;
}

async function confirmReconciled(orderId) {
  const data = await gql(ORDER_BALANCE_CHECK, { id: orderId });
  const order = data.order;
  const result = classifyBalanceDrift(
    order.total.gross.amount,
    order.totalCaptured.amount,
    order.totalRefunded.amount,
    order.totalBalance.amount
  );
  return result.status === "OK";
}

function toPlain(node) {
  return {
    id: node.id,
    number: node.number,
    total: node.total.gross.amount,
    totalCaptured: node.totalCaptured.amount,
    totalRefunded: node.totalRefunded.amount,
    totalBalance: node.totalBalance.amount,
  };
}

/**
 * pendingCorrections maps orderId -> { transactionId, eventType, amount },
 * populated only from a signed-off review, never guessed by the script.
 */
export async function run(pendingCorrections = {}) {
  let reported = 0;
  let corrected = 0;

  for await (const node of allOrders()) {
    const order = toPlain(node);
    const result = classifyBalanceDrift(order.total, order.totalCaptured, order.totalRefunded, order.totalBalance);
    if (result.status === "OK") continue;

    const reportRow = {
      orderId: order.id,
      orderNumber: order.number,
      expectedBalance: result.expectedBalance,
      reportedBalance: result.reportedBalance,
      driftedBy: result.driftedBy,
    };
    console.warn("Balance-drifted order found for finance review:", reportRow);
    reported++;

    // Correcting the ledger is never automatic. This branch only ever runs
    // for an order a human has signed off on, with the exact transaction,
    // event type, and amount they decided on after reading the raw events.
    const correction = pendingCorrections[order.id];
    if (!DRY_RUN && correction) {
      console.log(`Recording correcting event on transaction ${correction.transactionId} (signed off).`);
      await recordCorrectingEvent(correction.transactionId, correction.eventType, correction.amount);
      const reconciled = await confirmReconciled(order.id);
      if (reconciled) {
        console.log(`Order ${order.number} reconciled. totalBalance now matches.`);
      } else {
        console.error(`Order ${order.number} still drifted after correction. Needs manual review.`);
      }
      corrected++;
    }
  }

  console.log(`Done. ${reported} order(s) reported drifted, ${corrected} correction(s) recorded.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
