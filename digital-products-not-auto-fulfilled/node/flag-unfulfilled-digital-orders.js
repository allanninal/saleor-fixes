/**
 * Find Saleor orders that stayed Unfulfilled despite automatic digital
 * fulfillment being enabled, report them, and optionally fulfill the
 * confirmed-safe ones.
 *
 * automatic_fulfillment_digital_products, and the per-DigitalContent
 * override, are only read from inside automatically_fulfill_digital_lines(),
 * which runs during the payment-capture success path when an order becomes
 * fully paid through a real payment or transaction event during checkout
 * completion. Orders that become paid through orderMarkAsPaid, draft order
 * completion, a manual transaction adjustment, or a webhook outside that
 * signal never call that function, so their digital-only lines stay
 * Unfulfilled even with the setting on. A digital variant with no warehouse
 * Stock row is skipped the same way, since the routine still needs a stock
 * row to build a FulfillmentLine.
 *
 * This is flag and report, with an optional orderFulfill call gated by
 * DRY_RUN, and only for orders that are fully paid through the real payment
 * path, entirely digital, and backed by stock on every line. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/digital-products-not-auto-fulfilled/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const SHOP_DEFAULT_AUTO_FULFILL = (process.env.SHOP_AUTOMATIC_FULFILLMENT_DIGITAL || "true").toLowerCase() === "true";
const WAREHOUSE_ID = process.env.SALEOR_WAREHOUSE_ID || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ELIGIBLE_STATUSES = new Set(["UNFULFILLED", "PARTIALLY_FULFILLED"]);
const PAID_VIA_REAL_PAYMENT = new Set(["CHECKOUT_CAPTURE", "TRANSACTION_ACTION"]);
const MARK_AS_PAID_EVENT = "ORDER_MARKED_AS_PAID";

export function shouldAutoFulfill(order, shopDefault) {
  if (!order.is_paid) return false;
  if (!ELIGIBLE_STATUSES.has(order.status)) return false;
  if (!PAID_VIA_REAL_PAYMENT.has(order.paid_via)) return false;

  const lines = order.lines || [];
  if (lines.length === 0) return false;

  for (const line of lines) {
    if (line.is_shipping_required) return false;
    if (!line.has_stock) return false;

    const content = line.digital_content;
    if (content == null) return false;
    const effective = content.use_default_settings === false
      ? content.automatic_fulfillment
      : shopDefault;
    if (!effective) return false;
  }

  return true;
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
  orders(first: 100, after: $cursor, filter: { isFulfilled: false }) {
    edges {
      node {
        id
        number
        status
        isPaid
        lines {
          id
          isShippingRequired
          variant {
            id
            digitalContent { useDefaultSettings automaticFulfillment }
          }
        }
        events { type }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const WAREHOUSES_QUERY = `
query {
  warehouses(first: 100) {
    edges { node { id stocks { productVariant { id } quantity } } }
  }
}`;

const FULFILL_MUTATION = `
mutation($order: ID!, $lines: [OrderFulfillLineInput!]!) {
  orderFulfill(order: $order, input: {
    lines: $lines, notifyCustomer: true, allowStockToBeExceeded: false
  }) {
    fulfillments { id status }
    errors { field code message }
  }
}`;

function paidVia(order) {
  const events = order.events || [];
  if (events.some((e) => e.type === MARK_AS_PAID_EVENT)) return "MARK_AS_PAID";
  return "CHECKOUT_CAPTURE";
}

async function variantIdsWithStock() {
  const data = (await gql(WAREHOUSES_QUERY)).warehouses;
  const stocked = new Set();
  for (const edge of data.edges) {
    for (const stock of edge.node.stocks) {
      if (stock.quantity && stock.quantity > 0) stocked.add(stock.productVariant.id);
    }
  }
  return stocked;
}

function normalizeOrder(node, stockedVariantIds) {
  const lines = node.lines.map((line) => {
    const variant = line.variant || {};
    const content = variant.digitalContent;
    const digitalContent = content == null ? null : {
      use_default_settings: content.useDefaultSettings,
      automatic_fulfillment: content.automaticFulfillment,
    };
    return {
      id: line.id,
      is_shipping_required: line.isShippingRequired ?? true,
      digital_content: digitalContent,
      has_stock: stockedVariantIds.has(variant.id),
    };
  });
  return {
    id: node.id,
    number: node.number,
    is_paid: node.isPaid || false,
    status: node.status,
    paid_via: paidVia(node),
    lines,
  };
}

async function* unfulfilledOrders() {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_QUERY, { cursor })).orders;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function fulfillOrder(orderId, lineIds) {
  const lines = lineIds.map((lid) => ({
    orderLineId: lid,
    stocks: [{ quantity: 1, warehouse: WAREHOUSE_ID }],
  }));
  const result = (await gql(FULFILL_MUTATION, { order: orderId, lines })).orderFulfill;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.fulfillments;
}

export async function run() {
  const stockedVariantIds = await variantIdsWithStock();
  let flagged = 0;
  let fulfilled = 0;
  for await (const node of unfulfilledOrders()) {
    const order = normalizeOrder(node, stockedVariantIds);
    if (!shouldAutoFulfill(order, SHOP_DEFAULT_AUTO_FULFILL)) continue;

    flagged++;
    console.warn(
      `Order ${order.number} paid via ${order.paid_via}, all digital, has stock, still ${order.status}. ${DRY_RUN ? "would fulfill" : "fulfilling"}`
    );

    if (!DRY_RUN && WAREHOUSE_ID) {
      const lineIds = order.lines.map((line) => line.id);
      await fulfillOrder(order.id, lineIds);
      fulfilled++;
    }
  }

  console.log(
    `Done. ${flagged} order(s) flagged, ${fulfilled} ${DRY_RUN ? "would be fulfilled" : "fulfilled"}.`
  );
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
