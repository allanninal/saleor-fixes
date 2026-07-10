import { test } from "node:test";
import assert from "node:assert/strict";
import { findOversoldLines } from "./find-oversold.js";

const order = (orderId, over = {}) => ({
  order_id: orderId,
  status: "UNFULFILLED",
  lines: [{ sku: "SKU-1", warehouse_id: "wh-1", allocated_qty: 1 }],
  ...over,
});

const stock = (over = {}) => ({
  sku: "SKU-1",
  warehouse_id: "wh-1",
  on_hand_qty: 1,
  reported_allocated_qty: 1,
  ...over,
});

test("flags two orders that claim the same last unit", () => {
  const orders = [order("order-A"), order("order-B")];
  const stocks = [stock()];
  const result = findOversoldLines(orders, stocks);
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, "SKU-1");
  assert.equal(result[0].warehouse_id, "wh-1");
  assert.equal(result[0].recomputed_allocated_qty, 2);
  assert.equal(result[0].oversold_by, 1);
  assert.deepEqual(result[0].offending_order_ids, ["order-A", "order-B"]);
});

test("no flag when allocated matches stock", () => {
  const orders = [order("order-A")];
  const stocks = [stock()];
  assert.deepEqual(findOversoldLines(orders, stocks), []);
});

test("cancelled orders are excluded from recomputed demand", () => {
  const orders = [order("order-A", { status: "CANCELLED" }), order("order-B")];
  const stocks = [stock()];
  assert.deepEqual(findOversoldLines(orders, stocks), []);
});

test("flags when reported allocated disagrees with recomputed", () => {
  const orders = [order("order-A")];
  const stocks = [stock({ on_hand_qty: 5, reported_allocated_qty: 3 })];
  const result = findOversoldLines(orders, stocks);
  assert.equal(result.length, 1);
  assert.equal(result[0].reported_allocated_qty, 3);
  assert.equal(result[0].recomputed_allocated_qty, 1);
  assert.equal(result[0].oversold_by, 0);
});

test("separate warehouses are not confused", () => {
  const orders = [
    order("order-A", { lines: [{ sku: "SKU-1", warehouse_id: "wh-1", allocated_qty: 1 }] }),
    order("order-B", { lines: [{ sku: "SKU-1", warehouse_id: "wh-2", allocated_qty: 1 }] }),
  ];
  const stocks = [
    stock({ warehouse_id: "wh-1", on_hand_qty: 1, reported_allocated_qty: 1 }),
    stock({ warehouse_id: "wh-2", on_hand_qty: 1, reported_allocated_qty: 1 }),
  ];
  assert.deepEqual(findOversoldLines(orders, stocks), []);
});
