import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStockDrift } from "./detect-stock-drift.js";

const stock = (over = {}) => ({
  variantId: "gid://saleor/ProductVariant/1",
  sku: "SKU-1",
  warehouseId: "gid://saleor/Warehouse/1",
  quantity: 5,
  quantityAllocated: 0,
  ...over,
});

test("no drift when quantity covers allocations", () => {
  const result = detectStockDrift(stock(), [{ quantity: 2 }]);
  assert.equal(result.isDrift, false);
});

test("drift when allocated exceeds quantity", () => {
  const result = detectStockDrift(stock({ quantity: 1 }), [{ quantity: 3 }]);
  assert.deepEqual(result, { isDrift: true, delta: 2, reason: "allocated_exceeds_quantity" });
});

test("drift when known physical count exceeds quantity", () => {
  const result = detectStockDrift(stock({ quantity: 0 }), [], 12);
  assert.deepEqual(result, { isDrift: true, delta: 12, reason: "quantity_below_known_physical_count" });
});

test("drift when zero quantity with open allocations", () => {
  const result = detectStockDrift(stock({ quantity: 0 }), [{ quantity: 1 }]);
  assert.deepEqual(result, { isDrift: true, delta: 1, reason: "zero_quantity_with_open_allocations" });
});

test("no drift when zero quantity and no allocations", () => {
  const result = detectStockDrift(stock({ quantity: 0 }), []);
  assert.equal(result.isDrift, false);
});

test("no drift when known physical count matches", () => {
  const result = detectStockDrift(stock({ quantity: 5 }), [], 5);
  assert.equal(result.isDrift, false);
});

test("allocated exceeds quantity takes priority over known count", () => {
  const result = detectStockDrift(stock({ quantity: 2 }), [{ quantity: 5 }], 2);
  assert.deepEqual(result, { isDrift: true, delta: 3, reason: "allocated_exceeds_quantity" });
});

test("multiple allocations are summed", () => {
  const result = detectStockDrift(stock({ quantity: 1 }), [{ quantity: 1 }, { quantity: 1 }]);
  assert.deepEqual(result, { isDrift: true, delta: 1, reason: "allocated_exceeds_quantity" });
});
