/**
 * Find duplicate address rows saved on Saleor customer accounts.
 *
 * Every Saleor order with a shipping address stores that address as a new row
 * on the customer's account. Saleor does not de-duplicate against the
 * addresses the account already has, so a returning shopper who ships to the
 * same place every time slowly accumulates identical address rows, one per
 * order. The addresses match on street, city, postal code, country, and name,
 * but each is a separate row with its own opaque id, and the account address
 * book fills up with copies.
 *
 * This script pages through customers and their addresses, and a pure
 * function groups each customer's addresses by a normalized key. Any group
 * with more than one address is a duplicate cluster. The function keeps one
 * address per cluster, preferring the default shipping address, and returns
 * the ids of the rest as the duplicates to merge.
 *
 * Deleting is the risky part, so DRY_RUN defaults to true and the script only
 * reports the duplicate ids it found. Set DRY_RUN=false to actually call
 * addressDelete on the extra rows. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/duplicate-customer-address-rows/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function norm(value) {
  return (value || "").trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Build a normalized identity key for an address. Pure, no I/O.
 * Two addresses that share the same street, city, postal code, country, and
 * name are considered the same regardless of casing or stray whitespace.
 *
 * @param {object} address
 * @returns {string}
 */
export function addressKey(address) {
  const country = address.country || {};
  return [
    norm(address.firstName),
    norm(address.lastName),
    norm(address.streetAddress1),
    norm(address.streetAddress2),
    norm(address.city),
    norm(address.postalCode),
    norm(country.code),
  ].join("|");
}

/**
 * Pure decision function. No I/O.
 *
 * @param {{id:string,email:string,addresses:object[]}[]} customers
 * @returns {{customerId:string,email:string,key:string,keepId:string,duplicateIds:string[]}[]}
 */
export function findDuplicateAddresses(customers) {
  const results = [];
  for (const customer of customers) {
    const groups = new Map();
    for (const address of customer.addresses || []) {
      const key = addressKey(address);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(address);
    }

    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const keep = group.find((a) => a.isDefaultShippingAddress) || group[0];
      const duplicateIds = group.filter((a) => a.id !== keep.id).map((a) => a.id);
      if (duplicateIds.length === 0) continue;
      results.push({
        customerId: customer.id,
        email: customer.email,
        key,
        keepId: keep.id,
        duplicateIds,
      });
    }
  }
  return results;
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

const CUSTOMERS_QUERY = `
query($cursor: String) {
  customers(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        email
        addresses {
          id
          firstName
          lastName
          streetAddress1
          streetAddress2
          city
          postalCode
          country { code }
          isDefaultShippingAddress
        }
      }
    }
  }
}`;

const ADDRESS_DELETE = `
mutation($id: ID!) {
  addressDelete(id: $id) {
    errors { field message }
  }
}`;

async function* allCustomers() {
  let cursor = null;
  while (true) {
    const data = (await gql(CUSTOMERS_QUERY, { cursor })).customers;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function deleteAddress(id) {
  const data = await gql(ADDRESS_DELETE, { id });
  const errors = data.addressDelete.errors;
  if (errors && errors.length) throw new Error(JSON.stringify(errors));
}

export async function run() {
  const customers = [];
  for await (const node of allCustomers()) customers.push(node);

  const clusters = findDuplicateAddresses(customers);

  let totalDupes = 0;
  for (const cluster of clusters) {
    totalDupes += cluster.duplicateIds.length;
    console.warn(
      `Duplicate addresses for ${cluster.email}: keep ${cluster.keepId}, ${cluster.duplicateIds.length} duplicate(s)`,
      cluster.duplicateIds
    );
  }

  if (!DRY_RUN) {
    for (const cluster of clusters) {
      for (const id of cluster.duplicateIds) {
        await deleteAddress(id);
        console.log(`Deleted duplicate address ${id}`);
      }
    }
  }

  console.log(
    `Done. ${clusters.length} cluster(s), ${totalDupes} duplicate address(es) found. ${DRY_RUN ? "Dry run, nothing deleted." : "Duplicates deleted."}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
