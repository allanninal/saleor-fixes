/**
 * Complete Saleor checkouts that were paid but never converted to an Order.
 *
 * checkoutComplete is a separate mutation the storefront must call after the payment
 * provider confirms payment. If the tab closes, the app crashes, or the network drops
 * between the payment reaching authorizeStatus FULL and that final call, the Checkout
 * is left behind with money captured or authorized and no Order ever created.
 *
 * This lists checkouts with authorizeStatus: FULL, keeps only the ones aged past a
 * grace period with no Order yet, and calls checkoutComplete for each. Anything still
 * needing provider-side confirmation (a pending 3DS or redirect step) is flagged, not
 * forced. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/paid-checkout-never-converts-to-order/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES || 5);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PENDING_CHARGE_STATES = new Set(["PENDING", "PARTIAL"]);

/**
 * Pure decision function. No network calls, fully unit-testable with a fixed clock.
 * checkout: {authorizeStatus, chargeStatus, createdAt, hasOrder}
 * Returns {action: "complete"|"flag"|"skip", reason: string}
 */
export function shouldCompleteCheckout(checkout, nowIso, graceMinutes = 5) {
  if (checkout.hasOrder) return { action: "skip", reason: "already has an order" };
  if (checkout.authorizeStatus !== "FULL") return { action: "skip", reason: "not fully authorized" };
  const ageMinutes = (Date.parse(nowIso) - Date.parse(checkout.createdAt)) / 60000;
  if (ageMinutes < graceMinutes) return { action: "skip", reason: "too new, still likely mid-flow" };
  if (PENDING_CHARGE_STATES.has(checkout.chargeStatus)) {
    return { action: "flag", reason: "provider-side confirmation still pending" };
  }
  return { action: "complete", reason: "paid, aged past grace period, no order yet" };
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

const CHECKOUTS_QUERY = `
query {
  checkouts(first: 50, filter: {authorizeStatus: [FULL]}) {
    edges {
      node {
        id
        token
        created
        channel { slug }
        totalPrice { gross { amount currency } }
        authorizeStatus
        chargeStatus
        transactions { id chargeStatus authorizeStatus }
      }
    }
  }
}`;

const COMPLETE_MUTATION = `
mutation Complete($id: ID!) {
  checkoutComplete(id: $id) {
    order { id number }
    confirmationNeeded
    confirmationData
    errors { field code message }
  }
}`;

async function paidCheckouts() {
  const data = (await gql(CHECKOUTS_QUERY)).checkouts;
  return data.edges.map((edge) => {
    const node = edge.node;
    node.createdAt = node.created;
    // A checkout that already converted is deleted and replaced by an Order,
    // so anything returned by this query has no Order yet.
    node.hasOrder = false;
    return node;
  });
}

async function completeCheckout(checkoutId) {
  const result = (await gql(COMPLETE_MUTATION, { id: checkoutId })).checkoutComplete;
  if (result.errors.length) return { status: "unfixable", errors: result.errors };
  if (result.confirmationNeeded) return { status: "needs_confirmation", confirmationData: result.confirmationData };
  return { status: "completed", order: result.order };
}

export async function run() {
  const nowIso = new Date().toISOString();
  let completed = 0;
  let flagged = 0;
  for (const checkout of await paidCheckouts()) {
    const decision = shouldCompleteCheckout(checkout, nowIso, GRACE_MINUTES);
    if (decision.action === "skip") continue;
    if (decision.action === "flag") {
      console.warn(`Checkout ${checkout.token} flagged: ${decision.reason}`);
      flagged++;
      continue;
    }
    console.log(`Checkout ${checkout.token} eligible. ${DRY_RUN ? "would complete" : "completing"}`);
    if (!DRY_RUN) {
      const outcome = await completeCheckout(checkout.id);
      if (outcome.status !== "completed") {
        console.warn(`Checkout ${checkout.token} not completed:`, outcome);
        continue;
      }
    }
    completed++;
  }
  console.log(`Done. ${completed} checkout(s) ${DRY_RUN ? "to complete" : "completed"}, ${flagged} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
