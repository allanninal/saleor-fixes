/**
 * Flag Saleor checkouts that look like a stale, client side reused checkout
 * token rather than a fresh one from checkoutCreate.
 *
 * Saleor 3.x always inserts a new Checkout row from checkoutCreate and never
 * auto-reuses one, so a stale checkout almost always means the storefront or
 * app kept replaying a saved token/id instead of asking for a new one.
 *
 * Report only. Never edits a checkout or detaches a user. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/checkout-create-returns-stale-checkout/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const MAX_IDLE_HOURS = Number(process.env.MAX_IDLE_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function classifyStaleCheckout(checkout, maxIdleMs) {
  const reasons = [];

  const expected = checkout.expectedSessionId;
  if (expected !== undefined && expected !== null && expected !== checkout.storedSessionMeta) {
    reasons.push("session_mismatch");
  }

  if (checkout.voucherCode != null && checkout.voucherIsActive === false) {
    reasons.push("orphaned_voucher");
  }

  const lines = checkout.lines || [];
  if (lines.some((line) => line.isChannelListed === false)) {
    reasons.push("delisted_line");
  }

  const nowMs = Date.parse(checkout.now);
  const updatedMs = Date.parse(checkout.updatedAt);
  if (nowMs - updatedMs > maxIdleMs) {
    reasons.push("long_idle");
  }

  return { stale: reasons.length > 0, reasons };
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
  checkouts(first: 100, after: $cursor) {
    edges {
      node {
        id
        token
        created
        updatedAt
        user { id email }
        channel { slug }
        voucherCode
        discountName
        lines { id quantity variant { id product { id } } }
        metadata { key value }
        totalPrice { gross { amount currency } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const VOUCHER_QUERY = `
query($code: String!) {
  vouchers(first: 1, filter: { search: $code }) {
    edges { node { code usageLimit used endDate } }
  }
}`;

const VARIANT_LISTING_QUERY = `
query($id: ID!, $channel: String!) {
  productVariant(id: $id, channel: $channel) {
    id
    channelListings { channel { slug } }
  }
}`;

async function voucherIsActive(code, nowIso) {
  const edges = (await gql(VOUCHER_QUERY, { code })).vouchers.edges;
  if (!edges.length) return false;
  const node = edges[0].node;
  if (node.endDate && node.endDate < nowIso) return false;
  if (node.usageLimit !== null && node.used >= node.usageLimit) return false;
  return true;
}

async function variantIsChannelListed(variantId, channelSlug) {
  const data = await gql(VARIANT_LISTING_QUERY, { id: variantId, channel: channelSlug });
  const variant = data.productVariant;
  if (!variant) return false;
  return Boolean(variant.channelListings && variant.channelListings.length);
}

async function* openCheckouts() {
  let cursor = null;
  while (true) {
    const data = (await gql(CHECKOUTS_QUERY, { cursor })).checkouts;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function buildCheckoutShape(node, nowIso) {
  const channelSlug = node.channel?.slug;
  const voucherCode = node.voucherCode;
  let voucherActive = null;
  if (voucherCode) {
    voucherActive = await voucherIsActive(voucherCode, nowIso);
  }

  const lines = [];
  for (const line of node.lines || []) {
    const variantId = line.variant?.id;
    let listed = true;
    if (variantId && channelSlug) {
      listed = await variantIsChannelListed(variantId, channelSlug);
    }
    lines.push({ variantId, isChannelListed: listed });
  }

  const metadata = {};
  for (const m of node.metadata || []) metadata[m.key] = m.value;

  return {
    id: node.id,
    token: node.token,
    createdAt: node.created,
    updatedAt: node.updatedAt,
    userEmail: node.user?.email ?? null,
    channelSlug,
    voucherCode,
    lines,
    expectedSessionId: metadata.expected_session_id ?? null,
    storedSessionMeta: metadata.session_id ?? null,
    voucherIsActive: voucherActive,
    now: nowIso,
  };
}

export async function run() {
  const nowIso = new Date().toISOString();
  const maxIdleMs = MAX_IDLE_HOURS * 3600 * 1000;
  const mode = DRY_RUN ? "dry run" : "live";
  console.log(`Scanning open checkouts (${mode}, report only, max idle ${MAX_IDLE_HOURS}h)`);

  let flagged = 0;
  for await (const node of openCheckouts()) {
    const shape = await buildCheckoutShape(node, nowIso);
    const result = classifyStaleCheckout(shape, maxIdleMs);
    if (!result.stale) continue;
    flagged++;
    console.warn(
      `STALE checkout id=${shape.id} token=${shape.token} user=${shape.userEmail} ` +
      `channel=${shape.channelSlug} reasons=${result.reasons.join(",")}`
    );
  }
  console.log(`Done. ${flagged} checkout(s) flagged. No checkouts were changed.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
