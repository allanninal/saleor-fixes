import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKey, findDuplicateAddresses } from "./find-duplicate-customer-addresses.js";

const address = (over = {}) => ({
  id: "gid://saleor/Address/1",
  firstName: "Jane",
  lastName: "Doe",
  streetAddress1: "12 Oak Street",
  streetAddress2: "",
  city: "Portland",
  postalCode: "97201",
  country: { code: "US" },
  isDefaultShippingAddress: false,
  ...over,
});

const customer = (addresses, over = {}) => ({
  id: "gid://saleor/User/1",
  email: "jane@example.com",
  addresses,
  ...over,
});

test("key is case and whitespace insensitive", () => {
  const a = address({ streetAddress1: "12 Oak Street", city: "Portland" });
  const b = address({ id: "a2", streetAddress1: "  12  OAK street ", city: "portland " });
  assert.equal(addressKey(a), addressKey(b));
});

test("flags two identical addresses", () => {
  const result = findDuplicateAddresses([customer([address({ id: "a1" }), address({ id: "a2" })])]);
  assert.equal(result.length, 1);
  assert.equal(result[0].keepId, "a1");
  assert.deepEqual(result[0].duplicateIds, ["a2"]);
});

test("single address is never a duplicate", () => {
  assert.deepEqual(findDuplicateAddresses([customer([address({ id: "a1" })])]), []);
});

test("different addresses are not grouped", () => {
  const a1 = address({ id: "a1", streetAddress1: "12 Oak Street" });
  const a2 = address({ id: "a2", streetAddress1: "99 Elm Avenue" });
  assert.deepEqual(findDuplicateAddresses([customer([a1, a2])]), []);
});

test("default shipping address is kept", () => {
  const a1 = address({ id: "a1" });
  const a2 = address({ id: "a2", isDefaultShippingAddress: true });
  const a3 = address({ id: "a3" });
  const result = findDuplicateAddresses([customer([a1, a2, a3])]);
  assert.equal(result[0].keepId, "a2");
  assert.deepEqual([...result[0].duplicateIds].sort(), ["a1", "a3"]);
});

test("first address is kept when no default", () => {
  const a1 = address({ id: "a1" });
  const a2 = address({ id: "a2" });
  const a3 = address({ id: "a3" });
  const result = findDuplicateAddresses([customer([a1, a2, a3])]);
  assert.equal(result[0].keepId, "a1");
  assert.deepEqual(result[0].duplicateIds, ["a2", "a3"]);
});

test("streetAddress2 participates in the key", () => {
  const a1 = address({ id: "a1", streetAddress2: "Apt 4" });
  const a2 = address({ id: "a2", streetAddress2: "Apt 9" });
  assert.deepEqual(findDuplicateAddresses([customer([a1, a2])]), []);
});

test("country participates in the key", () => {
  const a1 = address({ id: "a1", country: { code: "US" } });
  const a2 = address({ id: "a2", country: { code: "CA" } });
  assert.deepEqual(findDuplicateAddresses([customer([a1, a2])]), []);
});

test("two separate clusters for one customer", () => {
  const a1 = address({ id: "a1", streetAddress1: "12 Oak Street" });
  const a2 = address({ id: "a2", streetAddress1: "12 Oak Street" });
  const b1 = address({ id: "b1", streetAddress1: "99 Elm Avenue" });
  const b2 = address({ id: "b2", streetAddress1: "99 Elm Avenue" });
  const result = findDuplicateAddresses([customer([a1, a2, b1, b2])]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((c) => c.keepId).sort(), ["a1", "b1"]);
});

test("customer with no addresses is skipped", () => {
  assert.deepEqual(findDuplicateAddresses([customer([])]), []);
});

test("missing country does not crash", () => {
  const a1 = address({ id: "a1", country: null });
  const a2 = address({ id: "a2", country: null });
  const result = findDuplicateAddresses([customer([a1, a2])]);
  assert.deepEqual(result[0].duplicateIds, ["a2"]);
});
