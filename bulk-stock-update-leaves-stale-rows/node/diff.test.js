import { test } from "node:test";
import assert from "node:assert/strict";
import { diffStockRows } from "./reconcile-bulk-stock.js";

const V1 = "gid://saleor/ProductVariant/1";
const W1 = "gid://saleor/Warehouse/1";
const W2 = "gid://saleor/Warehouse/2";

test("ok when actual matches intended", () => {
  const intended = [{ variantId: V1, warehouseId: W1, quantity: 10 }];
  const actual = [{ variantId: V1, warehouseId: W1, quantity: 10 }];
  const result = diffStockRows(intended, actual, []);
  assert.deepEqual(result, [{
    variantId: V1, warehouseId: W1,
    intendedQuantity: 10, actualQuantity: 10, status: "ok",
  }]);
});

test("stale when actual does not match", () => {
  const intended = [{ variantId: V1, warehouseId: W1, quantity: 10 }];
  const actual = [{ variantId: V1, warehouseId: W1, quantity: 4 }];
  const result = diffStockRows(intended, actual, []);
  assert.equal(result[0].status, "stale");
  assert.equal(result[0].actualQuantity, 4);
});

test("stale when actual missing entirely", () => {
  const intended = [{ variantId: V1, warehouseId: W2, quantity: 5 }];
  const result = diffStockRows(intended, [], []);
  assert.equal(result[0].status, "stale");
  assert.equal(result[0].actualQuantity, null);
});

test("reported error takes priority over mismatch", () => {
  const intended = [{ variantId: V1, warehouseId: W1, quantity: 10 }];
  const actual = [{ variantId: V1, warehouseId: W1, quantity: 4 }];
  const errors = [{ variantId: V1, warehouseId: W1, code: "NOT_FOUND" }];
  const result = diffStockRows(intended, actual, errors);
  assert.equal(result[0].status, "reported_error");
});

test("reported error even when actual matches", () => {
  const intended = [{ variantId: V1, warehouseId: W1, quantity: 10 }];
  const actual = [{ variantId: V1, warehouseId: W1, quantity: 10 }];
  const errors = [{ variantId: V1, warehouseId: W1, code: "INVALID" }];
  const result = diffStockRows(intended, actual, errors);
  assert.equal(result[0].status, "reported_error");
});

test("multiple rows get independent status", () => {
  const intended = [
    { variantId: V1, warehouseId: W1, quantity: 10 },
    { variantId: V1, warehouseId: W2, quantity: 20 },
  ];
  const actual = [
    { variantId: V1, warehouseId: W1, quantity: 10 },
    { variantId: V1, warehouseId: W2, quantity: 1 },
  ];
  const result = diffStockRows(intended, actual, []);
  const statuses = Object.fromEntries(result.map((r) => [r.warehouseId, r.status]));
  assert.equal(statuses[W1], "ok");
  assert.equal(statuses[W2], "stale");
});

test("empty intended returns empty list", () => {
  assert.deepEqual(diffStockRows([], [], []), []);
});

test("unrelated mutation error does not affect other rows", () => {
  const intended = [
    { variantId: V1, warehouseId: W1, quantity: 10 },
    { variantId: V1, warehouseId: W2, quantity: 20 },
  ];
  const actual = [
    { variantId: V1, warehouseId: W1, quantity: 10 },
    { variantId: V1, warehouseId: W2, quantity: 20 },
  ];
  const errors = [{ variantId: V1, warehouseId: W2, code: "NOT_FOUND" }];
  const result = diffStockRows(intended, actual, errors);
  const statuses = Object.fromEntries(result.map((r) => [r.warehouseId, r.status]));
  assert.equal(statuses[W1], "ok");
  assert.equal(statuses[W2], "reported_error");
});
