/**
 * Detect and reconcile Saleor checkouts with a stale shipping method after an address change.
 *
 * checkoutShippingAddressUpdate invalidates Saleor's shipping caches on the server, but a
 * client that only fetched availableShippingMethods once, at checkoutCreate or in the same
 * response as the address mutation, never re-fetches, so the screen keeps showing the
 * pre-update list. This re-fetches the checkout fresh, decides with a pure function whether
 * the previously selected method is still valid, and only ever reselects a method under a
 * DRY_RUN guard, logging the {checkoutId, oldMethodId, newMethodId} pair first.
 *
 * Guide: https://www.allanninal.dev/saleor/shipping-methods-stale-after-address-change/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STALE_TYPENAMES = new Set(["CheckoutProblemDeliveryMethodStale", "CheckoutProblemDeliveryMethodInvalid"]);

const FRESH_CHECKOUT_QUERY = `
query($id: ID!) {
  checkout(id: $id) {
    shippingAddress { country { code } }
    availableShippingMethods { id name }
    shippingMethods { id name }
    problems {
      __typename
      ... on CheckoutProblemDeliveryMethodStale { __typename }
      ... on CheckoutProblemDeliveryMethodInvalid { __typename }
    }
    deliveryMethod { ... on ShippingMethod { id } }
  }
}`;

const DELIVERY_METHOD_UPDATE = `
mutation($id: ID!, $methodId: ID) {
  checkoutDeliveryMethodUpdate(id: $id, deliveryMethodId: $methodId) {
    checkout { id deliveryMethod { ... on ShippingMethod { id } } }
    errors { field message }
  }
}`;

/**
 * Pure decision logic, no I/O.
 *
 * isStale is true when oldMethodId is non-null and not present in freshMethods,
 * or when problems includes CheckoutProblemDeliveryMethodStale or
 * CheckoutProblemDeliveryMethodInvalid. replacementId is the first fresh method
 * id when stale, or null if the fresh list is empty; otherwise it is oldMethodId.
 */
export function decideStaleShipping(oldMethodId, freshMethods, problems) {
  const freshIds = freshMethods.map((m) => m.id);
  const hasStaleProblem = (problems || []).some((p) => STALE_TYPENAMES.has(p.__typename));
  const isStale = (oldMethodId != null && !freshIds.includes(oldMethodId)) || hasStaleProblem;
  const replacementId = isStale ? (freshIds[0] ?? null) : oldMethodId;
  return { isStale, replacementId };
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Saleor ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function fetchFreshCheckout(checkoutId) {
  return (await gql(FRESH_CHECKOUT_QUERY, { id: checkoutId })).checkout;
}

async function reselectDeliveryMethod(checkoutId, newMethodId) {
  const result = (await gql(DELIVERY_METHOD_UPDATE, { id: checkoutId, methodId: newMethodId })).checkoutDeliveryMethodUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.checkout;
}

async function reconcileCheckout(checkoutId) {
  const checkout = await fetchFreshCheckout(checkoutId);
  const oldMethodId = checkout.deliveryMethod?.id ?? null;
  const freshMethods = checkout.availableShippingMethods || [];
  const problems = checkout.problems || [];

  const decision = decideStaleShipping(oldMethodId, freshMethods, problems);
  if (!decision.isStale) return false;

  console.warn(
    `Checkout ${checkoutId} stale shipping method. old=${oldMethodId} new=${decision.replacementId} `
    + `${DRY_RUN ? "would reselect" : "reselecting"}`
  );
  if (!DRY_RUN && decision.replacementId !== null) {
    await reselectDeliveryMethod(checkoutId, decision.replacementId);
  }
  return true;
}

export async function run(checkoutIds) {
  let fixed = 0;
  for (const checkoutId of checkoutIds) {
    if (await reconcileCheckout(checkoutId)) fixed++;
  }
  console.log(`Done. ${fixed} checkout(s) ${DRY_RUN ? "to reconcile" : "reconciled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = (process.env.CHECKOUT_IDS || "").split(",").filter(Boolean);
  run(ids).catch((err) => { console.error(err); process.exit(1); });
}
