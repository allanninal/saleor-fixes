/**
 * Release Saleor stock reservations left behind by abandoned checkouts.
 *
 * Saleor's optional stock reservation feature allocates warehouse stock to a
 * checkout the moment items are added, and that reservation is only cleared
 * by a periodic Celery beat task. If that task queue is misconfigured,
 * delayed, or the worker is down, expired reservation rows are never
 * deleted, so Stock.quantity stays debited by phantom holds from carts
 * nobody will finish.
 *
 * This script lists checkouts, flags the ones whose stockReservationExpires
 * is already in the past or whose lastChange is older than
 * CHECKOUT_TTL_BEFORE_RELEASING_FUNDS (default 6h), and calls
 * checkoutLinesDelete to strip the lines from the flagged checkout. That is
 * the documented, non-destructive way to force Saleor to drop the
 * associated stock reservation without deleting the checkout or touching
 * any order or payment record.
 *
 * Never mutates Stock.quantity or allocations directly. Run on a schedule.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/abandoned-checkout-stock-not-released/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const TTL_MINUTES = Number(process.env.TTL_MINUTES || 360);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No network or DB calls.
 *
 * checkouts: [{id, token, lastChange, stockReservationExpires, lines: [{id, quantity, variantSku}]}]
 * now: a Date to compare against
 * ttlMinutes: the TTL window in minutes (CHECKOUT_TTL_BEFORE_RELEASING_FUNDS)
 *
 * Returns one entry per stale checkout: {id, lineIds, reason}
 * reason is "expired_reservation" when stockReservationExpires has passed,
 * or "past_ttl" when lastChange is older than the TTL window and no
 * reservation expiry is set. Checkouts with stockReservationExpires null
 * and lastChange within the TTL window are skipped.
 */
export function findStaleReservedCheckouts(checkouts, now, ttlMinutes) {
  const stale = [];
  const ttlMs = ttlMinutes * 60 * 1000;
  for (const checkout of checkouts) {
    const lineIds = checkout.lines.map((line) => line.id);
    if (checkout.stockReservationExpires !== null && checkout.stockReservationExpires !== undefined) {
      const expiresAt = new Date(checkout.stockReservationExpires).getTime();
      if (expiresAt <= now.getTime()) {
        stale.push({ id: checkout.id, lineIds, reason: "expired_reservation" });
        continue;
      }
    }
    if (!checkout.lastChange) continue;
    const changedAt = new Date(checkout.lastChange).getTime();
    if (changedAt <= now.getTime() - ttlMs) {
      stale.push({ id: checkout.id, lineIds, reason: "past_ttl" });
    }
  }
  return stale;
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
query($cursor: String) {
  checkouts(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        token
        lastChange
        stockReservationExpires
        lines { id quantity variant { id sku } }
      }
    }
  }
}`;

const LINES_DELETE = `
mutation($id: ID!, $linesIds: [ID!]!) {
  checkoutLinesDelete(id: $id, linesIds: $linesIds) {
    checkout { id stockReservationExpires }
    errors { field message }
  }
}`;

async function* allCheckouts() {
  let cursor = null;
  while (true) {
    const data = (await gql(CHECKOUTS_QUERY, { cursor })).checkouts;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function releaseReservation(checkoutId, lineIds) {
  const result = (await gql(LINES_DELETE, { id: checkoutId, linesIds: lineIds })).checkoutLinesDelete;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.checkout;
}

export async function run() {
  const now = new Date();
  const checkouts = [];
  for await (const checkout of allCheckouts()) checkouts.push(checkout);
  const flagged = findStaleReservedCheckouts(checkouts, now, TTL_MINUTES);
  let released = 0;
  for (const entry of flagged) {
    console.warn(`Checkout ${entry.id} stale (${entry.reason}), ${entry.lineIds.length} line(s). ${DRY_RUN ? "would release" : "releasing"}`);
    if (!DRY_RUN) {
      const checkout = await releaseReservation(entry.id, entry.lineIds);
      console.log(`Checkout ${checkout.id} stockReservationExpires now ${checkout.stockReservationExpires}`);
    }
    released++;
  }
  console.log(`Done. ${released} stale checkout(s) ${DRY_RUN ? "to release" : "released"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
