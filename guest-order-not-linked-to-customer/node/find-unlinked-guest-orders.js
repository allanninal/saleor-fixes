/**
 * Find Saleor orders placed as a guest whose userEmail matches a registered
 * customer's email, even though order.user is null.
 *
 * Saleor links order.user to a User only when the checkout itself was
 * performed while logged in. The linkage happens in
 * _process_user_data_for_order during checkout completion, and it reads the
 * checkout's user_id, not its email. A guest checkout stores the buyer's
 * email on order.userEmail but never gets a user_id, so order.user stays
 * null even when the email matches an existing account, because Saleor
 * deliberately never runs a post-hoc lookup against the User table by email
 * (see saleor/saleor discussion #8508, issue #432).
 *
 * This script only ever reports. There is no first-class orderUpdate field
 * for reassigning a customer after the fact, and auto-linking by email alone
 * would let anyone claim another account's order history just by entering
 * their email at guest checkout. Under DRY_RUN=true (the default) it only
 * logs the report. When DRY_RUN=false it additionally writes a CSV report
 * file for staff review. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/guest-order-not-linked-to-customer/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPORT_PATH = process.env.REPORT_PATH || "unlinked-guest-orders.csv";

function norm(email) {
  return (email || "").trim().toLowerCase();
}

/**
 * Pure decision function. No I/O.
 *
 * @param {{id:string,number:string,userEmail:string|null,user:{id:string}|null}[]} orders
 * @param {{id:string,email:string}[]} customers
 * @returns {{orderId:string,orderNumber:string,userEmail:string,matchedCustomerId:string}[]}
 */
export function findUnlinkedGuestOrders(orders, customers) {
  const byEmail = new Map();
  for (const customer of customers) {
    const key = norm(customer.email);
    if (key) byEmail.set(key, customer.id);
  }

  const flagged = [];
  for (const order of orders) {
    if (order.user !== null && order.user !== undefined) continue;
    const email = norm(order.userEmail);
    if (!email) continue;
    const matchedId = byEmail.get(email);
    if (!matchedId) continue;
    flagged.push({
      orderId: order.id,
      orderNumber: order.number,
      userEmail: order.userEmail,
      matchedCustomerId: matchedId,
    });
  }
  return flagged;
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
    edges { node { id number userEmail user { id } } }
  }
}`;

const CUSTOMERS_QUERY = `
query($cursor: String) {
  customers(first: 50, after: $cursor, filter: {}) {
    pageInfo { hasNextPage endCursor }
    edges { node { id email } }
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

async function* allCustomers() {
  let cursor = null;
  while (true) {
    const data = (await gql(CUSTOMERS_QUERY, { cursor })).customers;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

function toPlainOrder(node) {
  return {
    id: node.id,
    number: node.number,
    userEmail: node.userEmail ?? null,
    user: node.user ?? null,
  };
}

export function toCsv(flaggedRows) {
  const fields = ["orderId", "orderNumber", "userEmail", "matchedCustomerId"];
  const lines = [fields.join(",")];
  for (const row of flaggedRows) {
    lines.push(fields.map((f) => JSON.stringify(row[f] ?? "")).join(","));
  }
  return lines.join("\n");
}

export async function run() {
  const orders = [];
  for await (const node of allOrders()) orders.push(toPlainOrder(node));

  const customers = [];
  for await (const node of allCustomers()) customers.push(node);

  const flagged = findUnlinkedGuestOrders(orders, customers);

  for (const row of flagged) {
    console.warn("Unlinked guest order found for staff review:", row);
  }

  if (!DRY_RUN) {
    writeFileSync(REPORT_PATH, toCsv(flagged));
    console.log(`Report written to ${REPORT_PATH}`);
  }

  console.log(
    `Done. ${flagged.length} unlinked guest order(s) found. ${DRY_RUN ? "Dry run, no file written." : "Report file written."}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
