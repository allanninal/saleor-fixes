/**
 * Find Saleor vouchers whose used count climbed past their usageLimit
 * under concurrent checkout completion.
 *
 * Saleor increments a voucher's used counter only after checkout or order
 * completion, and the check that used is still below usageLimit is not
 * atomically guarded against a second completion doing the same read at
 * nearly the same instant. Under concurrent completion, two checkouts can
 * both pass the check before either write lands, pushing used above
 * usageLimit (saleor/saleor#544). A retried checkoutComplete across a 3DS
 * payment confirmation can also double count one redemption
 * (saleor/saleor#8219).
 *
 * Rolling back a completed, paid order to unwind an over-redeemed voucher
 * is a business decision, so this script never cancels or refunds an
 * order on its own. Under DRY_RUN=true (the default) it only reports every
 * overage: the voucher, both counts, and the affected order ids. When
 * DRY_RUN=false the only automated repair is to stop new redemptions by
 * setting the voucher's endDate to now. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/voucher-usable-past-usage-limit/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EXCLUDED_STATUSES = new Set(["DRAFT", "CANCELED"]);

/**
 * Pure decision function. No network or DB I/O.
 *
 * voucher: {id, code, usageLimit, used}
 * orders: array of {id, voucherId, status}
 *
 * Returns null when there is nothing to flag, otherwise a report object
 * with voucherId, overageCount, actualRedemptions, and affectedOrderIds.
 */
export function detectVoucherOverage(voucher, orders) {
  const usageLimit = voucher.usageLimit;
  if (usageLimit === null || usageLimit === undefined) return null;

  const counted = orders.filter(
    (o) => o.voucherId === voucher.id && !EXCLUDED_STATUSES.has(o.status)
  );
  const actualRedemptions = counted.length;
  const overageCount = Math.max(0, actualRedemptions - usageLimit);

  const used = voucher.used ?? 0;
  if (overageCount === 0 && used <= usageLimit) return null;

  return {
    voucherId: voucher.id,
    overageCount,
    actualRedemptions,
    affectedOrderIds: counted.map((o) => o.id),
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

const VOUCHERS_QUERY = `
query($cursor: String) {
  vouchers(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node { id code usageLimit used singleUse applyOncePerCustomer }
    }
  }
}`;

const ORDERS_BY_VOUCHER_QUERY = `
query($voucherCode: String!, $cursor: String) {
  orders(first: 50, after: $cursor, filter: { voucherCode: $voucherCode }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node { id number created voucher { id } voucherCode status }
    }
  }
}`;

const STOP_VOUCHER_MUTATION = `
mutation($id: ID!, $endDate: DateTime!) {
  voucherUpdate(id: $id, input: { endDate: $endDate }) {
    voucher { id endDate }
    errors { field message code }
  }
}`;

async function* limitedVouchers() {
  let cursor = null;
  while (true) {
    const data = (await gql(VOUCHERS_QUERY, { cursor })).vouchers;
    for (const edge of data.edges) {
      if (edge.node.usageLimit !== null && edge.node.usageLimit !== undefined) {
        yield edge.node;
      }
    }
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function* ordersForVoucher(voucherCode) {
  let cursor = null;
  while (true) {
    const data = (await gql(ORDERS_BY_VOUCHER_QUERY, { voucherCode, cursor })).orders;
    for (const edge of data.edges) {
      const node = edge.node;
      yield {
        id: node.id,
        voucherId: node.voucher?.id ?? null,
        status: node.status,
      };
    }
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function stopFurtherRedemptions(voucherId) {
  const nowIso = new Date().toISOString();
  const result = (await gql(STOP_VOUCHER_MUTATION, { id: voucherId, endDate: nowIso })).voucherUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
}

export async function run() {
  const reports = [];
  for await (const voucher of limitedVouchers()) {
    const orders = [];
    for await (const order of ordersForVoucher(voucher.code)) orders.push(order);

    const report = detectVoucherOverage(voucher, orders);
    if (!report) continue;

    console.warn(
      `Overage: voucher=${report.voucherId} code=${voucher.code} usageLimit=${voucher.usageLimit} used=${voucher.used} actualRedemptions=${report.actualRedemptions} overageCount=${report.overageCount} orders=${JSON.stringify(report.affectedOrderIds)}`
    );
    reports.push(report);

    if (!DRY_RUN) {
      console.log(`Stopping further redemptions on voucher ${report.voucherId} (${voucher.code}).`);
      await stopFurtherRedemptions(report.voucherId);
    }
  }

  console.log(
    `Done. ${reports.length} voucher(s) over their usage limit${DRY_RUN ? "" : ", further redemptions stopped"}.`
  );
  return reports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
