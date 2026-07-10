/**
 * Flag Saleor orders that cannot be unfulfilled or have a line deleted because
 * they contain a gift card line, because fulfilling that line already issued a
 * live, spendable GiftCard record that Saleor cannot safely claw back
 * (see saleor/saleor#9654, the OrderErrorCode enum, and the gift cards docs).
 *
 * Saleor deliberately has no override mutation for CANNOT_CANCEL_FULFILLMENT,
 * NON_REMOVABLE_GIFT_LINE, or NON_EDITABLE_GIFT_LINE, so this script never calls
 * orderFulfillmentCancel, orderLineDelete, orderLineUpdate, or orderDelete
 * against a gift-card-line order. Under DRY_RUN=true (the default) it only logs
 * a report entry for each blocked order. The guarded remediation path
 * (deactivateGiftCard, addReconciliationNote) is opt-in only, meant to run
 * after a human has confirmed the refund side out of band, and should only
 * ever run with DRY_RUN=false.
 *
 * Guide: https://www.allanninal.dev/saleor/gift-card-order-blocks-unfulfill-delete/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FULFILLMENT_BLOCKING_STATUSES = new Set(["FULFILLED", "PARTIALLY_FULFILLED", "WAITING_FOR_APPROVAL"]);

/**
 * Pure decision logic, no I/O. Mirrors Saleor's own mutation checks:
 * FulfillmentCancel.validate_order() calling order_has_gift_card_lines(order),
 * and OrderLineDelete / OrderLineUpdate checking line.isGift.
 */
export function classifyGiftCardOrderBlock(order) {
  const giftCards = order.giftCards || [];
  const lines = order.lines || [];
  const fulfillments = order.fulfillments || [];

  const hasBlockingFulfillment = fulfillments.some((f) => FULFILLMENT_BLOCKING_STATUSES.has(f.status));
  if (giftCards.length > 0 && hasBlockingFulfillment) {
    return {
      blocked: true,
      blockingCode: "CANNOT_CANCEL_FULFILLMENT",
      reason: "Order has gift card lines and a fulfillment that cannot be cancelled.",
    };
  }

  if (lines.some((line) => line.isGift)) {
    return {
      blocked: true,
      blockingCode: "NON_REMOVABLE_GIFT_LINE",
      reason: "Order has a gift card line that cannot be deleted.",
    };
  }

  return { blocked: false, blockingCode: null, reason: "No gift card lifecycle block found." };
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
        status
        isPaid
        giftCards { id last4CodeChars }
        lines { id isGift quantity }
        fulfillments { id status }
      }
    }
  }
}`;

// Guarded remediation only. Never calls orderFulfillmentCancel, orderLineDelete,
// or orderDelete against a gift-card-line order. Deactivate, then refund
// out of band, then leave a note.
const GIFT_CARD_DEACTIVATE = `
mutation($id: ID!) {
  giftCardDeactivate(id: $id) {
    giftCard { id isActive }
    errors { field code message }
  }
}`;

const ORDER_NOTE_ADD = `
mutation($order: ID!, $input: OrderNoteInput!) {
  orderNoteAdd(order: $order, input: $input) {
    event { id }
    errors { field message }
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

// Opt-in only. Never called by run(). Wire in yourself once a human has
// confirmed the refund side is handled out of band.
async function deactivateGiftCard(giftCardId) {
  const result = (await gql(GIFT_CARD_DEACTIVATE, { id: giftCardId })).giftCardDeactivate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.giftCard;
}

// Opt-in only. Never called by run().
async function addReconciliationNote(orderId, message) {
  const result = (await gql(ORDER_NOTE_ADD, { order: orderId, input: { message } })).orderNoteAdd;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
}

export async function run() {
  let flagged = 0;

  for await (const order of allOrders()) {
    const decision = classifyGiftCardOrderBlock(order);
    if (!decision.blocked) continue;

    const reportEntry = {
      orderId: order.id,
      number: order.number,
      blockingCode: decision.blockingCode,
    };
    console.warn("Blocked gift card order found.", reportEntry, DRY_RUN ? "(dry run, reporting only)" : "(reporting only)");
    flagged++;
  }

  console.log(`Done. ${flagged} blocked order(s) flagged for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
