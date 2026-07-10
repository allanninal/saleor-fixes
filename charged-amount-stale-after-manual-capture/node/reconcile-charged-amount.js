/**
 * Reconcile Saleor orders whose charged amount stays stale after a manual capture.
 *
 * Saleor's totalCharged and TransactionItem.chargedAmount only recalculate from
 * reported TransactionEvent records, never live from the gateway. A manual capture
 * made outside the normal event flow leaves chargePendingAmount open until an app
 * reports it back. This script cross-checks stalled transactions against the
 * gateway by pspReference and reports the confirmed state back with
 * transactionEventReport. Ambiguous mismatches are flagged for finance, never
 * auto-written. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/charged-amount-stale-after-manual-capture/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const GATEWAY_API_URL = process.env.GATEWAY_API_URL || "https://gateway.example.com/v1";
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "dummy-key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * @param {{chargedAmount: number, chargePendingAmount: number, events: {type: string, pspReference: string}[]}} saleorTxn
 * @param {{pspReference: string, capturedAmount: number, status: "succeeded"|"failed"|"pending"}} gatewayCapture
 * @returns {"IN_SYNC"|"NEEDS_REPORT_SUCCESS"|"NEEDS_REPORT_FAILURE"|"AMOUNT_MISMATCH_FLAG"}
 */
export function classifyChargeReconciliation(saleorTxn, gatewayCapture) {
  const { status, pspReference, capturedAmount } = gatewayCapture;

  if (status === "pending") return "IN_SYNC";

  if (status === "succeeded") {
    const hasMatchingSuccess = (saleorTxn.events || []).some(
      (e) => e.type === "CHARGE_SUCCESS" && e.pspReference === pspReference
    );
    if (!hasMatchingSuccess) {
      if (saleorTxn.chargedAmount < capturedAmount) return "NEEDS_REPORT_SUCCESS";
      if (saleorTxn.chargedAmount > capturedAmount) return "AMOUNT_MISMATCH_FLAG";
    }
    return "IN_SYNC";
  }

  if (status === "failed" && (saleorTxn.chargePendingAmount || 0) > 0) {
    return "NEEDS_REPORT_FAILURE";
  }

  return "IN_SYNC";
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

async function fetchGatewayCapture(pspReference) {
  const res = await fetch(`${GATEWAY_API_URL}/charges/${pspReference}`, {
    headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Gateway ${res.status}`);
  const body = await res.json();
  return { pspReference, capturedAmount: body.capturedAmount, status: body.status };
}

const ORDERS_QUERY = `
query($cursor: String) {
  orders(first: 25, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id number chargeStatus isPaid
        totalCharged { amount currency }
        totalAuthorized { amount currency }
        transactions {
          id pspReference
          chargedAmount { amount currency }
          chargePendingAmount { amount currency }
          authorizedAmount { amount currency }
          events { type pspReference createdAt }
        }
      }
    }
  }
}`;

const REPORT_MUTATION = `
mutation TransactionEventReport($id: ID!, $type: TransactionEventTypeEnum!, $amount: PositiveDecimal!, $pspReference: String!, $availableActions: [TransactionActionEnum!]) {
  transactionEventReport(id: $id, type: $type, amount: $amount, pspReference: $pspReference, availableActions: $availableActions) {
    alreadyReported
    transaction { id chargedAmount { amount } }
    errors { field message code }
  }
}`;

async function* candidateOrders() {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function reportEvent(transactionId, eventType, amount, pspReference) {
  const result = (await gql(REPORT_MUTATION, {
    id: transactionId,
    type: eventType,
    amount,
    pspReference,
    availableActions: [],
  })).transactionEventReport;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result;
}

export async function run() {
  let reported = 0;
  let flagged = 0;
  for await (const order of candidateOrders()) {
    for (const txn of order.transactions || []) {
      const pspReference = txn.pspReference;
      const pending = txn.chargePendingAmount?.amount || 0;
      if (!pspReference || !pending) continue;

      const saleorTxn = {
        chargedAmount: txn.chargedAmount?.amount || 0,
        chargePendingAmount: pending,
        events: txn.events || [],
      };
      const gatewayCapture = await fetchGatewayCapture(pspReference);
      const decision = classifyChargeReconciliation(saleorTxn, gatewayCapture);

      if (decision === "NEEDS_REPORT_SUCCESS") {
        console.log(`Order ${order.number} txn ${txn.id}: gateway confirms capture. ${DRY_RUN ? "would report" : "reporting"}`);
        if (!DRY_RUN) await reportEvent(txn.id, "CHARGE_SUCCESS", gatewayCapture.capturedAmount, pspReference);
        reported++;
      } else if (decision === "NEEDS_REPORT_FAILURE") {
        console.log(`Order ${order.number} txn ${txn.id}: gateway confirms failure. ${DRY_RUN ? "would report" : "reporting"}`);
        if (!DRY_RUN) await reportEvent(txn.id, "CHARGE_FAILURE", pending, pspReference);
        reported++;
      } else if (decision === "AMOUNT_MISMATCH_FLAG") {
        console.warn(`Order ${order.number} txn ${txn.id}: amount mismatch, flagged for finance review.`);
        flagged++;
      }
    }
  }
  console.log(`Done. ${reported} event(s) ${DRY_RUN ? "to report" : "reported"}, ${flagged} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
