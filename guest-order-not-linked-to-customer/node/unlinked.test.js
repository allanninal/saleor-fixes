import { test } from "node:test";
import assert from "node:assert/strict";
import { findUnlinkedGuestOrders, toCsv } from "./find-unlinked-guest-orders.js";

const order = (over = {}) => ({
  id: "gid://saleor/Order/1",
  number: "1001",
  userEmail: "jane@example.com",
  user: null,
  ...over,
});

const customer = (over = {}) => ({
  id: "gid://saleor/User/1",
  email: "jane@example.com",
  ...over,
});

test("flags guest order matching a customer email", () => {
  const result = findUnlinkedGuestOrders([order()], [customer()]);
  assert.deepEqual(result, [{
    orderId: "gid://saleor/Order/1",
    orderNumber: "1001",
    userEmail: "jane@example.com",
    matchedCustomerId: "gid://saleor/User/1",
  }]);
});

test("skips order already linked to a user", () => {
  const linked = order({ user: { id: "gid://saleor/User/1" } });
  assert.deepEqual(findUnlinkedGuestOrders([linked], [customer()]), []);
});

test("skips order with no matching customer", () => {
  assert.deepEqual(findUnlinkedGuestOrders([order({ userEmail: "stranger@example.com" })], [customer()]), []);
});

test("skips order with no email", () => {
  assert.deepEqual(findUnlinkedGuestOrders([order({ userEmail: null })], [customer()]), []);
});

test("skips order with blank email", () => {
  assert.deepEqual(findUnlinkedGuestOrders([order({ userEmail: "   " })], [customer()]), []);
});

test("matches case insensitively and trims whitespace", () => {
  const result = findUnlinkedGuestOrders(
    [order({ userEmail: "  Jane@Example.com  " })],
    [customer({ email: "jane@example.com" })],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].matchedCustomerId, "gid://saleor/User/1");
});

test("multiple orders only flags the unlinked matches", () => {
  const orders = [
    order({ id: "o1", number: "1001" }),
    order({ id: "o2", number: "1002", user: { id: "gid://saleor/User/9" } }),
    order({ id: "o3", number: "1003", userEmail: "nomatch@example.com" }),
  ];
  const result = findUnlinkedGuestOrders(orders, [customer()]);
  assert.deepEqual(result.map((row) => row.orderId), ["o1"]);
});

test("no customers means no flags", () => {
  assert.deepEqual(findUnlinkedGuestOrders([order()], []), []);
});

test("toCsv includes header and one row per flagged order", () => {
  const rows = [{ orderId: "o1", orderNumber: "1001", userEmail: "jane@example.com", matchedCustomerId: "u1" }];
  const csv = toCsv(rows);
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "orderId,orderNumber,userEmail,matchedCustomerId");
});
