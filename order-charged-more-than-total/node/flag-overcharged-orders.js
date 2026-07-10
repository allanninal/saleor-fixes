/**
 * Flag Saleor orders where totalCharged plus totalAuthorized exceeds the
 * order total, because Saleor tracks authorizedAmount and chargedAmount
 * independently per TransactionItem and aggregates them without a hard cap
 * against order.total (see saleor/saleor#4162, saleor/saleor#7399, and the
 * order.chargeStatus OVERCHARGED value in the docs).
 *
 * This script never calls orderGrantedRefundCreate or
 * transactionRequestRefundForGrantedRefund by default. Under DRY_RUN=true
 * (the default) it only logs the proposed granted refund input for each
 * overcharged order for a human to review. The guarded repair path
 * (createGrantedRefund) is opt-in only, meant to run after a human approves
 * the amount, and should only ever run with DRY_RUN=false. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/order-charged-more-than-total/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const EPSILON = Number(process.env.OVERCHARGE_EPSILON || 0.005);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * order: { totalGrossAmount: number, totalCharged: number, totalAuthorized: number, currency: string }
 * transactions: Array<{ chargedAmount: number, authorizedAmount: number }>, falls back to
 *   order.totalCharged / order.totalAuthorized when empty or omitted.
 *
 * Returns { isOvercharged, capturedPlusAuthorized, overageAmount }.
 */
export function decideOverchargeFlag(order, transactions = [], epsilon = 0.005) {
  const capturedPlusAuthorized = transactions.length
    ? transactions.reduce((sum, t) => sum + (t.chargedAmount || 0) + (t.authorizedAmount || 0), 0)
    : (order.totalCharged || 0) + (order.totalAuthorized || 0);

  const totalGross = order.totalGrossAmount || 0;
  const overageAmount = capturedPlusAuthorized - totalGross;
  const isOvercharged = overageAmount > epsilon;

  return {
    isOvercharged,
    capturedPlusAuthorized,
    overageAmount: isOvercharged ? Math.max(overageAmount, 0) : 0,
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
query FlagOverchargedOrders($first: Int!, $after: String) {
  orders(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        chargeStatus
        totalCharged { amount currency }
        totalAuthorized { amount currency }
        totalBalance { amount currency }
        total { gross { amount currency } }
        transactions {
          id
          chargedAmount { amount }
          authorizedAmount { amount }
          refundedAmount { amount }
        }
      }
    }
  }
}`;

const GRANTED_REFUND_CREATE = `
mutation($orderId: ID!, $amount: PositiveDecimal!, $reason: String!) {
  orderGrantedRefundCreate(orderId: $orderId, input: { amount: $amount, reason: $reason }) {
    orderGrantedRefund { id amount { amount } }
    errors { field code message }
  }
}`;

// Opt-in only. Never called by run(). Only fire after a human approves the
// grantedRefund record created above, and only with DRY_RUN=false.
const REQUEST_REFUND_FOR_GRANTED_REFUND = `
mutation($transactionId: ID!, $grantedRefundId: ID!) {
  transactionRequestRefundForGrantedRefund(id: $transactionId, grantedRefundId: $grantedRefundId) {
    transaction { id }
    errors { field code message }
  }
}`;

async function* allOrders(pageSize = 50) {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { first: pageSize, after: cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

// Opt-in only. Never called by run(). Wire in yourself after a human
// approves the flagged overage amount.
async function createGrantedRefund(orderId, overageAmount, reason) {
  const result = (await gql(GRANTED_REFUND_CREATE, {
    orderId,
    amount: Math.round(overageAmount * 100) / 100,
    reason,
  })).orderGrantedRefundCreate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.orderGrantedRefund.id;
}

// Opt-in only. Never called by run(). Executes the refund against the
// gateway once a granted refund has been approved.
async function requestRefundForGrantedRefund(transactionId, grantedRefundId) {
  const result = (await gql(REQUEST_REFUND_FOR_GRANTED_REFUND, {
    transactionId,
    grantedRefundId,
  })).transactionRequestRefundForGrantedRefund;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.transaction.id;
}

function toPlain(node) {
  return {
    id: node.id,
    number: node.number,
    chargeStatus: node.chargeStatus,
    totalCharged: node.totalCharged?.amount ?? 0,
    totalAuthorized: node.totalAuthorized?.amount ?? 0,
    totalBalance: node.totalBalance?.amount ?? 0,
    totalGrossAmount: node.total?.gross?.amount ?? 0,
    currency: node.total?.gross?.currency ?? null,
  };
}

function toPlainTransactions(node) {
  return (node.transactions || []).map((t) => ({
    id: t.id,
    chargedAmount: t.chargedAmount?.amount ?? 0,
    authorizedAmount: t.authorizedAmount?.amount ?? 0,
    refundedAmount: t.refundedAmount?.amount ?? 0,
  }));
}

export async function run() {
  let flagged = 0;

  for await (const node of allOrders()) {
    const order = toPlain(node);
    const transactions = toPlainTransactions(node);
    const decision = decideOverchargeFlag(order, transactions, EPSILON);
    if (!decision.isOvercharged) continue;

    const reportEntry = {
      orderId: order.id,
      number: order.number,
      chargeStatus: order.chargeStatus,
      capturedPlusAuthorized: decision.capturedPlusAuthorized,
      orderTotal: order.totalGrossAmount,
      overageAmount: Math.round(decision.overageAmount * 100) / 100,
      totalBalance: order.totalBalance,
      transactions,
    };
    console.warn(
      "Overcharged order found.", reportEntry,
      DRY_RUN ? "(dry run, reporting only)" : "(reporting only, refund requires approval)"
    );
    flagged++;

    const proposedInput = {
      orderId: order.id,
      amount: Math.round(decision.overageAmount * 100) / 100,
      reason: "Overcharge auto-detected: captured+authorized exceeded order total",
    };
    console.log("Proposed grantedRefund input:", proposedInput);
  }

  console.log(`Done. ${flagged} overcharged order(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
