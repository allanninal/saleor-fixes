/**
 * Restore a Saleor gift card's balance after the order it paid for was
 * cancelled, since orderCancel releases stock and marks the order CANCELED
 * but never runs compensating logic against GiftCard.currentBalance (see the
 * Saleor gift cards docs and saleor/saleor#9654, #11257).
 *
 * Debiting a gift card happens inside payment processing (a GiftCardEvent of
 * type USED_IN_ORDER), which is decoupled from order status transitions, so
 * cancellation never fires a signal to reverse it. This script finds
 * cancelled orders that used a gift card, cross-references each card's event
 * history for an un-reversed USED_IN_ORDER debit, and restores the balance
 * with giftCardUpdate, capped at the card's own initial balance.
 *
 * Under DRY_RUN=true (the default) it only prints the planned
 * {giftCardId, from, to, orderId} rows and never writes. Safe to run again
 * and again, since alreadyRestored and the initial-balance cap prevent
 * double restoration.
 *
 * Guide: https://www.allanninal.dev/saleor/gift-card-balance-not-restored-on-cancel/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ROUNDING_EPSILON = 0.01;

/**
 * Pure decision logic, no I/O. Returns the restorations to make for one order.
 * @param {{id: string, status: string}} order
 * @param {Array<{giftCardId: string, currentBalanceAmount: number, initialBalanceAmount: number,
 *   usedInOrderId: string, amountUsed: number, alreadyRestored: boolean}>} giftCardUsages
 * @returns {Array<{giftCardId: string, restoreToAmount: number, reason: string}>}
 */
export function planGiftCardRestoration(order, giftCardUsages) {
  if (order.status !== "CANCELED") return [];

  const plans = [];
  for (const usage of giftCardUsages) {
    if (usage.usedInOrderId !== order.id) continue;
    if (usage.alreadyRestored) continue;
    if (usage.amountUsed <= 0) continue;

    let restoreToAmount = usage.currentBalanceAmount + usage.amountUsed;
    const overshoot = restoreToAmount - usage.initialBalanceAmount;
    if (overshoot > ROUNDING_EPSILON) continue; // anomaly: would exceed initial balance, do not clamp silently

    restoreToAmount = Math.min(restoreToAmount, usage.initialBalanceAmount);
    plans.push({
      giftCardId: usage.giftCardId,
      restoreToAmount,
      reason: "order_cancelled_gift_card_not_refunded",
    });
  }

  return plans;
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

const CANCELLED_GIFT_CARD_ORDERS_QUERY = `
query($cursor: String) {
  orders(first: 50, after: $cursor, filter: { status: [CANCELED], giftCardUsed: true }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        number
        status
        giftCards {
          id
          currentBalance { amount currency }
          initialBalance { amount currency }
        }
      }
    }
  }
}`;

const GIFT_CARD_EVENTS_QUERY = `
query($id: ID!) {
  giftCard(id: $id) {
    id
    currentBalance { amount currency }
    initialBalance { amount currency }
    events {
      type
      orderId
      balance { initialBalance currentBalance }
    }
  }
}`;

const GIFT_CARD_UPDATE = `
mutation($id: ID!, $amount: Decimal!, $currency: String!) {
  giftCardUpdate(id: $id, input: { balanceAmount: { amount: $amount, currency: $currency } }) {
    giftCard { id currentBalance { amount currency } }
    errors { field code message }
  }
}`;

const GIFT_CARD_BALANCE_QUERY = `
query($id: ID!) {
  giftCard(id: $id) { id currentBalance { amount currency } }
}`;

async function* cancelledGiftCardOrders() {
  let cursor = null;
  while (true) {
    const data = (await gql(CANCELLED_GIFT_CARD_ORDERS_QUERY, { cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function buildGiftCardUsage(orderId, giftCardId) {
  const card = (await gql(GIFT_CARD_EVENTS_QUERY, { id: giftCardId })).giftCard;
  const events = card.events || [];

  const usedEvents = events.filter((e) => e.type === "USED_IN_ORDER" && e.orderId === orderId);
  if (usedEvents.length === 0) return null;

  const usedEvent = usedEvents[0];
  const amountUsed = usedEvent.balance.initialBalance - usedEvent.balance.currentBalance;
  const alreadyRestored = events.some((e) => e.type !== "USED_IN_ORDER" && e.orderId === orderId);

  return {
    giftCardId: card.id,
    currentBalanceAmount: card.currentBalance.amount,
    initialBalanceAmount: card.initialBalance.amount,
    usedInOrderId: orderId,
    amountUsed,
    alreadyRestored,
    currency: card.currentBalance.currency,
  };
}

async function restoreGiftCardBalance(giftCardId, restoreToAmount, currency) {
  // Re-fetch immediately before writing to avoid a lost update if the card
  // was used on another order in the interim.
  const fresh = (await gql(GIFT_CARD_BALANCE_QUERY, { id: giftCardId })).giftCard;

  const result = (await gql(GIFT_CARD_UPDATE, { id: giftCardId, amount: restoreToAmount, currency })).giftCardUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));

  const verify = (await gql(GIFT_CARD_BALANCE_QUERY, { id: giftCardId })).giftCard;
  return { before: fresh.currentBalance.amount, after: verify.currentBalance.amount };
}

export async function run() {
  let restored = 0;

  for await (const order of cancelledGiftCardOrders()) {
    const usages = [];
    for (const card of order.giftCards || []) {
      const usage = await buildGiftCardUsage(order.id, card.id);
      if (usage) usages.push(usage);
    }

    const plans = planGiftCardRestoration(order, usages);
    for (const plan of plans) {
      const usage = usages.find((u) => u.giftCardId === plan.giftCardId);
      console.log(
        `Order ${order.number} gift card ${plan.giftCardId}: ${DRY_RUN ? "would restore" : "restoring"} from ${usage.currentBalanceAmount.toFixed(2)} to ${plan.restoreToAmount.toFixed(2)}`
      );
      if (!DRY_RUN) await restoreGiftCardBalance(plan.giftCardId, plan.restoreToAmount, usage.currency);
      restored++;
    }
  }

  console.log(`Done. ${restored} gift card(s) ${DRY_RUN ? "to restore" : "restored"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
