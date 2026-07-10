/**
 * Find Saleor voucher codes whose stored usage counter was double
 * incremented by a two-stage payment gateway calling checkoutComplete twice
 * for the same checkout, once for confirmationNeeded and once after the
 * customer confirms (see saleor/saleor#8219, the Voucher and VoucherCode
 * object docs, and the orders query docs).
 *
 * This script never writes the usage counter. Saleor has no public
 * voucherCodeUsageSet mutation, so under DRY_RUN=true (the default, and the
 * only mode this script supports out of the box) it logs a report entry
 * for every overcounted code: {code, storedUsed, realUsage, delta}. Hand
 * that report to staff for a manual correction in the dashboard, or wire in
 * your own app-level correction mutation if you have built one. Run on a
 * schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/voucher-usage-double-incremented/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const VOUCHER_ID = process.env.SALEOR_VOUCHER_ID || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const COMPLETED_STATUSES = new Set(["FULFILLED", "PARTIALLY_FULFILLED", "UNFULFILLED"]);

/**
 * Pure decision function. code: { id, code, storedUsed }. qualifyingOrders:
 * Array<{ id, status, isPaid }>. Returns { action, correctedUsed, delta }.
 *
 * Real usage counts only orders that actually completed: paid, or reached
 * FULFILLED / PARTIALLY_FULFILLED / UNFULFILLED. Cancelled, draft, and
 * abandoned-checkout artifacts never count. If stored usage is at or below
 * real usage there is nothing to do (no overcount, or an out-of-scope
 * undercount). If stored usage is higher, the code was overcounted by the
 * difference, and the corrected value is the real usage.
 */
export function decideVoucherUsageCorrection(code, qualifyingOrders) {
  const realUsage = qualifyingOrders.filter(
    (o) => o.isPaid || COMPLETED_STATUSES.has(o.status)
  ).length;
  const storedUsed = code.storedUsed;

  if (storedUsed <= realUsage) {
    return { action: "none", correctedUsed: storedUsed, delta: 0 };
  }

  return {
    action: "decrement",
    correctedUsed: realUsage,
    delta: storedUsed - realUsage,
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

const VOUCHER_QUERY = `
query($id: ID!) {
  voucher(id: $id) {
    id
    usageLimit
    codes(first: 100) {
      edges { node { id code used } }
    }
  }
}`;

const ORDERS_FOR_CODE_QUERY = `
query($code: String!, $cursor: String) {
  orders(first: 100, after: $cursor, filter: { voucherCode: $code }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node { id number created voucherCode status isPaid paymentStatus }
    }
  }
}`;

async function voucherCodes(voucherId) {
  const data = (await gql(VOUCHER_QUERY, { id: voucherId })).voucher;
  return data.codes.edges.map((edge) => ({
    id: edge.node.id,
    code: edge.node.code,
    storedUsed: edge.node.used,
  }));
}

async function* ordersForCode(code) {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_FOR_CODE_QUERY, { code, cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

export async function run() {
  if (!VOUCHER_ID) {
    throw new Error("Set SALEOR_VOUCHER_ID to the voucher you want to reconcile.");
  }

  let flagged = 0;
  for (const code of await voucherCodes(VOUCHER_ID)) {
    const qualifyingOrders = [];
    for await (const order of ordersForCode(code.code)) qualifyingOrders.push(order);

    const decision = decideVoucherUsageCorrection(code, qualifyingOrders);
    if (decision.action === "none") continue;

    const reportEntry = {
      code: code.code,
      storedUsed: code.storedUsed,
      realUsage: decision.correctedUsed,
      delta: decision.delta,
    };
    console.warn(
      "Overcounted voucher code found.",
      reportEntry,
      DRY_RUN ? "(dry run, reporting only)" : "(reporting only, no public write mutation)"
    );
    flagged++;
  }

  console.log(`Done. ${flagged} voucher code(s) flagged for staff correction.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
