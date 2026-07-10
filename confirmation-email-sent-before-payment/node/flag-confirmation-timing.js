/**
 * Flag Saleor orders whose confirmation email fired before the payment ever
 * succeeded, because send_order_confirmation runs synchronously inside
 * checkoutComplete at order-creation time, never gated on a successful
 * CHARGE_SUCCESS or AUTHORIZATION_SUCCESS transaction event (see saleor/saleor#3527
 * and the TransactionEvent and Order object docs).
 *
 * This script never un-sends an email, since Saleor has no mutation for that.
 * Under DRY_RUN=true (the default) it only logs a report entry for each flagged
 * order for support follow-up. Only orders that clear CANCEL_GRACE_HOURS with
 * still no successful charge are cancelled with orderCancel, and only when
 * DRY_RUN=false. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/confirmation-email-sent-before-payment/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const CANCEL_GRACE_HOURS = Number(process.env.CANCEL_GRACE_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/** Return the ISO timestamp of the order's PLACED event, or null. */
export function confirmEventTimestamp(order) {
  for (const event of order.events || []) {
    if (event.type === "PLACED") return event.date;
  }
  return null;
}

/**
 * Return the earliest successful charge timestamp for the order, or null.
 * Prefers the current Transactions API (TransactionEvent type CHARGE_SUCCESS)
 * and falls back to the legacy Payment/Transaction model (kind CAPTURE,
 * isSuccess true) for deployments still on the old payments flow.
 */
export function chargeSuccessTimestamp(order, transactions) {
  let times = [];
  for (const t of transactions || []) {
    for (const e of t.events || []) {
      if (e.type === "CHARGE_SUCCESS") times.push(e.createdAt);
    }
  }
  if (times.length === 0) {
    for (const payment of order.payments || []) {
      for (const tx of payment.transactions || []) {
        if (tx.kind === "CAPTURE" && tx.isSuccess) times.push(tx.created);
      }
    }
  }
  return times.length ? times.sort()[0] : null;
}

/**
 * Pure decision function. No I/O, fully unit-testable.
 *
 * confirmEventTs: epoch millis | null - when the PLACED event (and therefore
 *   send_order_confirmation) fired.
 * chargeSuccessTs: epoch millis | null - earliest successful charge event, if any.
 * orderIsPaid: boolean - order.isPaid at flag time.
 * now: epoch millis - current time, passed in so the function stays pure.
 * cancelGraceHours: number - how long to wait before an unpaid order with a
 *   premature confirmation becomes eligible for cancellation.
 *
 * Returns one of "ok", "flag_email_premature", "flag_and_eligible_for_cancel".
 */
export function decideConfirmationTimingIssue(confirmEventTs, chargeSuccessTs, orderIsPaid,
                                               now, cancelGraceHours = 24) {
  if (confirmEventTs === null || confirmEventTs === undefined) return "ok";
  if (chargeSuccessTs !== null && chargeSuccessTs !== undefined && confirmEventTs <= chargeSuccessTs) return "ok";
  if (chargeSuccessTs !== null && chargeSuccessTs !== undefined && confirmEventTs > chargeSuccessTs) return "ok";
  if (orderIsPaid) return "ok";
  const ageHours = (now - confirmEventTs) / (1000 * 60 * 60);
  if (ageHours >= cancelGraceHours) return "flag_and_eligible_for_cancel";
  return "flag_email_premature";
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
query OrdersWithTimeline($first: Int!, $after: String) {
  orders(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id number isPaid status created
        events { type date }
        payments { id isActive transactions { id kind isSuccess created } }
      }
    }
  }
}`;

const TRANSACTIONS_QUERY = `
query OrderTransactions($id: ID!) {
  order(id: $id) {
    id isPaid
    transactions { id events { type createdAt pspReference } }
  }
}`;

const CANCEL_ORDER = `
mutation CancelUnpaidOrder($id: ID!) {
  orderCancel(id: $id) {
    order { id status }
    errors { field message code }
  }
}`;

async function* allOrders() {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { first: 50, after: cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function fetchTransactions(orderId) {
  const data = await gql(TRANSACTIONS_QUERY, { id: orderId });
  return data.order.transactions;
}

async function cancelUnpaidOrder(orderId) {
  const result = (await gql(CANCEL_ORDER, { id: orderId })).orderCancel;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.order.status;
}

export async function run() {
  const now = Date.now();
  let flagged = 0;
  let cancelled = 0;

  for await (const order of allOrders()) {
    const confirmIso = confirmEventTimestamp(order);
    if (confirmIso === null) continue;

    const transactions = await fetchTransactions(order.id);
    const chargeIso = chargeSuccessTimestamp(order, transactions);

    const confirmTs = Date.parse(confirmIso);
    const chargeTs = chargeIso ? Date.parse(chargeIso) : null;

    const outcome = decideConfirmationTimingIssue(
      confirmTs, chargeTs, order.isPaid === true, now, CANCEL_GRACE_HOURS
    );
    if (outcome === "ok") continue;

    flagged++;
    const reportEntry = {
      orderId: order.id,
      number: order.number,
      confirmEventTs: confirmIso,
      chargeSuccessTs: chargeIso,
      isPaid: order.isPaid === true,
      status: order.status,
      outcome,
    };
    console.warn("Confirmation timing issue found.", reportEntry);

    if (outcome === "flag_and_eligible_for_cancel") {
      if (!DRY_RUN) {
        await cancelUnpaidOrder(order.id);
        cancelled++;
      } else {
        console.log(`Order ${order.number} would be cancelled (dry run).`);
      }
    }
  }

  console.log(`Done. ${flagged} order(s) flagged, ${cancelled} cancelled.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
