import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStockDesync, diffSnapshots, hasMatchingDelivery } from "./detect-stock-webhook-desync.js";

const record = (over = {}) => ({
  variantId: "gid://saleor/ProductVariant/1",
  warehouseId: "gid://saleor/Warehouse/1",
  quantityBefore: 20,
  quantityAfter: 15,
  matchingDeliveryFound: false,
  recentMutationHint: "UNKNOWN",
  ...over,
});

test("no desync when quantity unchanged", () => {
  const result = classifyStockDesync(record({ quantityBefore: 10, quantityAfter: 10 }));
  assert.deepEqual(result, { isDesynced: false, severity: "none", reason: "no change" });
});

test("no desync when delivery found", () => {
  const result = classifyStockDesync(record({ matchingDeliveryFound: true }));
  assert.deepEqual(result, { isDesynced: false, severity: "none", reason: "webhook delivered" });
});

test("critical when order fulfill hint", () => {
  const result = classifyStockDesync(record({ recentMutationHint: "ORDER_FULFILL" }));
  assert.equal(result.isDesynced, true);
  assert.equal(result.severity, "critical");
});

test("critical when order cancel hint", () => {
  const result = classifyStockDesync(record({ recentMutationHint: "ORDER_CANCEL" }));
  assert.equal(result.severity, "critical");
});

test("critical when crosses zero", () => {
  const result = classifyStockDesync(record({ quantityBefore: 0, quantityAfter: 5, recentMutationHint: "UNKNOWN" }));
  assert.equal(result.severity, "critical");
});

test("critical when large delta", () => {
  const result = classifyStockDesync(record({ quantityBefore: 100, quantityAfter: 85, recentMutationHint: "UNKNOWN" }));
  assert.equal(result.severity, "critical");
});

test("warn when small unknown delta", () => {
  const result = classifyStockDesync(record({ quantityBefore: 100, quantityAfter: 99, recentMutationHint: "UNKNOWN" }));
  assert.deepEqual(result, {
    isDesynced: true,
    severity: "warn",
    reason: "suspected UNKNOWN, delta -1 with no matching PRODUCT_VARIANT_STOCK_UPDATED delivery",
  });
});

test("no desync when quantity unchanged even with critical hint", () => {
  const result = classifyStockDesync(record({ quantityBefore: 5, quantityAfter: 5, recentMutationHint: "ORDER_FULFILL" }));
  assert.equal(result.isDesynced, false);
});

test("delivery found wins over critical hint", () => {
  const result = classifyStockDesync(record({ matchingDeliveryFound: true, recentMutationHint: "ORDER_FULFILL" }));
  assert.equal(result.isDesynced, false);
});

test("diffSnapshots finds changed pairs only", () => {
  const previous = { "v1::w1": { variantId: "v1", warehouseId: "w1", quantity: 10 } };
  const current = {
    "v1::w1": { variantId: "v1", warehouseId: "w1", quantity: 7 },
    "v2::w1": { variantId: "v2", warehouseId: "w1", quantity: 3 },
  };
  const deltas = diffSnapshots(previous, current);
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0], { variantId: "v1", warehouseId: "w1", quantityBefore: 10, quantityAfter: 7 });
});

test("hasMatchingDelivery finds payload with matching variant and warehouse", () => {
  const deliveries = [
    { payload: JSON.stringify({ productVariant: { id: "v1" }, warehouse: { id: "w1" } }) },
  ];
  assert.equal(hasMatchingDelivery(deliveries, "v1", "w1"), true);
  assert.equal(hasMatchingDelivery(deliveries, "v2", "w1"), false);
});

test("hasMatchingDelivery ignores unparseable payloads", () => {
  const deliveries = [{ payload: "not json" }];
  assert.equal(hasMatchingDelivery(deliveries, "v1", "w1"), false);
});
