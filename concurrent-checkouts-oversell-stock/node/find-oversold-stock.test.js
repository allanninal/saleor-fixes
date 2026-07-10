import { test } from "node:test";
import assert from "node:assert/strict";
import { findOversoldStocks } from "./find-oversold-stock.js";

const stock = (over = {}) => ({
  variantId: "gid://saleor/ProductVariant/1",
  sku: "SKU-1",
  warehouseId: "gid://saleor/Warehouse/1",
  warehouseSlug: "main",
  quantity: 1,
  quantityAllocated: 1,
  ...over,
});

test("no oversold when allocated equals quantity", () => {
  assert.deepEqual(findOversoldStocks([stock()]), []);
});

test("flags oversold when allocated exceeds quantity", () => {
  const result = findOversoldStocks([stock({ quantityAllocated: 2 })]);
  assert.deepEqual(result, [{
    variantId: "gid://saleor/ProductVariant/1",
    sku: "SKU-1",
    warehouseId: "gid://saleor/Warehouse/1",
    delta: 1,
  }]);
});

test("no oversold when allocated is less than quantity", () => {
  assert.deepEqual(findOversoldStocks([stock({ quantity: 5, quantityAllocated: 3 })]), []);
});

test("sorted by delta descending", () => {
  const rows = [
    stock({ sku: "SMALL", quantity: 10, quantityAllocated: 11 }),
    stock({ sku: "BIG", quantity: 1, quantityAllocated: 6 }),
  ];
  const result = findOversoldStocks(rows);
  assert.deepEqual(result.map((row) => row.sku), ["BIG", "SMALL"]);
});

test("only oversold rows are returned", () => {
  const rows = [
    stock({ sku: "OK", quantity: 5, quantityAllocated: 5 }),
    stock({ sku: "OVER", quantity: 2, quantityAllocated: 4 }),
  ];
  const result = findOversoldStocks(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, "OVER");
  assert.equal(result[0].delta, 2);
});

test("zero quantity and zero allocated is not oversold", () => {
  assert.deepEqual(findOversoldStocks([stock({ quantity: 0, quantityAllocated: 0 })]), []);
});

test("negative delta is not oversold", () => {
  assert.deepEqual(findOversoldStocks([stock({ quantity: 100, quantityAllocated: 1 })]), []);
});
