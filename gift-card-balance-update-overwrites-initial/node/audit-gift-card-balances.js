/**
 * Find Saleor gift cards whose balance was overwritten by a giftCardUpdate
 * call that used balanceAmount to top up the remaining balance on a card
 * that had already been partially spent (see the GiftCard object docs and
 * the giftCardUpdate mutation docs).
 *
 * balanceAmount on GiftCardUpdateInput is written to both initialBalance
 * and currentBalance in one go, with no server-side check for whether the
 * card had already been spent down. This script never writes a corrected
 * balance. Saleor keeps no separate ledger column, so the true remaining
 * balance only survives as the oldCurrentBalance snapshot on the
 * GiftCardEvent just before the faulty update. Under DRY_RUN=true (the
 * default, and the only mode this script supports out of the box) it logs
 * a report entry for every affected card. Hand that report to staff for a
 * confirmed manual correction. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/gift-card-balance-update-overwrites-initial/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. Takes a plain card object:
 * { initialBalanceAmount, currentBalanceAmount, events: [
 *     { type, oldInitialBalanceAmount, oldCurrentBalanceAmount,
 *       newInitialBalanceAmount, newCurrentBalanceAmount }, ...
 * ] }
 * Returns { affected, reason, recoveredCurrentBalanceAmount }.
 */
export function classifyGiftCardBalanceOverwrite(card) {
  if (card.currentBalanceAmount > card.initialBalanceAmount) {
    return { affected: true, reason: "current_exceeds_initial", recoveredCurrentBalanceAmount: null };
  }

  for (const event of card.events) {
    if (event.type !== "UPDATED") continue;
    const { oldInitialBalanceAmount, oldCurrentBalanceAmount, newInitialBalanceAmount, newCurrentBalanceAmount } = event;
    if (oldInitialBalanceAmount == null || oldCurrentBalanceAmount == null) continue;
    if (oldCurrentBalanceAmount === oldInitialBalanceAmount) continue;
    if (newInitialBalanceAmount == null || newCurrentBalanceAmount == null) continue;
    if (newInitialBalanceAmount !== newCurrentBalanceAmount) continue;
    return { affected: true, reason: "update_reset_spent_card", recoveredCurrentBalanceAmount: oldCurrentBalanceAmount };
  }

  return { affected: false, reason: null, recoveredCurrentBalanceAmount: null };
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

const GIFT_CARDS_QUERY = `
query($cursor: String) {
  giftCards(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        displayCode
        isActive
        initialBalance { amount currency }
        currentBalance { amount currency }
        created
        lastUsedOn
        events(first: 50) {
          edges {
            node {
              type
              date
              balance { initialBalance currentBalance oldInitialBalance oldCurrentBalance }
            }
          }
        }
      }
    }
  }
}`;

function toPlainCard(node) {
  const events = node.events.edges.map((edge) => {
    const ev = edge.node;
    const bal = ev.balance || {};
    return {
      type: ev.type,
      oldInitialBalanceAmount: bal.oldInitialBalance ?? null,
      oldCurrentBalanceAmount: bal.oldCurrentBalance ?? null,
      newInitialBalanceAmount: bal.initialBalance ?? null,
      newCurrentBalanceAmount: bal.currentBalance ?? null,
    };
  });
  return {
    id: node.id,
    displayCode: node.displayCode,
    initialBalanceAmount: node.initialBalance.amount,
    currentBalanceAmount: node.currentBalance.amount,
    events,
  };
}

async function* giftCards() {
  let cursor = null;
  while (true) {
    const data = (await gql(GIFT_CARDS_QUERY, { cursor })).giftCards;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

export async function run() {
  let flagged = 0;
  for await (const node of giftCards()) {
    const card = toPlainCard(node);
    const result = classifyGiftCardBalanceOverwrite(card);
    if (!result.affected) continue;

    const reportEntry = {
      id: card.id,
      displayCode: card.displayCode,
      recoveredCurrentBalanceAmount: result.recoveredCurrentBalanceAmount,
      currentBalanceAmount: card.currentBalanceAmount,
      initialBalanceAmount: card.initialBalanceAmount,
      reason: result.reason,
    };
    console.warn(
      "Overwritten gift card balance found.",
      reportEntry,
      DRY_RUN ? "(dry run, reporting only)" : "(reporting only, confirm before any write)"
    );
    flagged++;
  }

  console.log(`Done. ${flagged} gift card(s) flagged for staff review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
