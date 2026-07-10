import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLineTax, reconcileOrder } from "./audit-tax-rounding.js";

test("exact match is not a mismatch", () => {
  const { isMismatch, expectedTax, delta } = checkLineTax(100.0, 0.22, 22.0);
  assert.equal(isMismatch, false);
  assert.equal(expectedTax, 22.0);
  assert.equal(delta, 0);
});

test("high quantity, low unit price drift is not flagged at tolerance", () => {
  // line.unitPrice is derived by dividing the already-rounded
  // line.totalPrice by quantity, so recomputing tax from unitPrice * qty
  // instead of from totalPrice.net directly can drift by several cents for
  // a high quantity, low unit price line. Here total_net=2.39 at qty=96
  // gives a rounded unit price of 0.02, and 96 * 0.02 = 1.92, not 2.39.
  // Saleor's real tax is computed on totalPrice.net (2.39), giving 0.53,
  // versus a naive unitPrice*qty recomputation giving 0.42, an 11 cent gap
  // that is exactly the kind of amplified per-unit rounding remainder
  // documented in saleor/saleor#6720. Checking against totalPrice.net (the
  // source of truth) instead of unitPrice * qty must not flag this.
  const totalNet = 2.39;
  const actualTax = 0.53; // round(total_net * 0.22, 2), Saleor's own computation
  const { isMismatch } = checkLineTax(totalNet, 0.22, actualTax, 2, 1);
  assert.equal(isMismatch, false);
});

test("injected corrupted line is flagged", () => {
  const { isMismatch, expectedTax, delta } = checkLineTax(100.0, 0.22, 30.0);
  assert.equal(isMismatch, true);
  assert.equal(expectedTax, 22.0);
  assert.equal(delta, 8.0);
});

test("one cent drift within tolerance is not a mismatch", () => {
  const { isMismatch } = checkLineTax(50.0, 0.2, 10.01, 2, 1);
  assert.equal(isMismatch, false);
});

test("two cent drift beyond tolerance is flagged", () => {
  const { isMismatch, delta } = checkLineTax(50.0, 0.2, 10.03, 2, 1);
  assert.equal(isMismatch, true);
  assert.equal(delta, 0.03);
});

test("reconcileOrder flags real aggregation bug", () => {
  const order = {
    id: "T3JkZXI6MQ==",
    number: "1001",
    total: { tax: { amount: 99.0 } },
    shippingPrice: { tax: { amount: 1.0 } },
    lines: [
      {
        id: "T3JkZXJMaW5lOjE=", quantity: 1, taxRate: 0.2,
        totalPrice: { net: { amount: 100.0 }, tax: { amount: 20.0 } },
      },
    ],
  };
  const result = reconcileOrder(order);
  assert.equal(result.aggregationBug, true);
  assert.equal(result.expectedOrderTax, 21.0);
  assert.equal(result.actualOrderTax, 99.0);
  assert.equal(result.aggregationDelta, 78.0);
});

test("reconcileOrder OK when totals match Saleor's own sum", () => {
  const order = {
    id: "T3JkZXI6Mg==",
    number: "1002",
    total: { tax: { amount: 21.0 } },
    shippingPrice: { tax: { amount: 1.0 } },
    lines: [
      {
        id: "T3JkZXJMaW5lOjI=", quantity: 1, taxRate: 0.2,
        totalPrice: { net: { amount: 100.0 }, tax: { amount: 20.0 } },
      },
    ],
  };
  const result = reconcileOrder(order);
  assert.equal(result.aggregationBug, false);
  assert.deepEqual(result.lineMismatches, []);
});

test("reconcileOrder flags line mismatch but no aggregation bug", () => {
  const order = {
    id: "T3JkZXI6Mw==",
    number: "1003",
    total: { tax: { amount: 30.0 } },
    shippingPrice: { tax: { amount: 0.0 } },
    lines: [
      {
        id: "T3JkZXJMaW5lOjM=", quantity: 1, taxRate: 0.2,
        // actual tax (30.0) is way off expected (20.0), a corrupted line, but
        // order.total.tax (30.0) does equal the sum of line tax (30.0) plus
        // shipping (0.0), so this is not an aggregation bug.
        totalPrice: { net: { amount: 100.0 }, tax: { amount: 30.0 } },
      },
    ],
  };
  const result = reconcileOrder(order);
  assert.equal(result.aggregationBug, false);
  assert.equal(result.lineMismatches.length, 1);
  assert.equal(result.lineMismatches[0].lineId, "T3JkZXJMaW5lOjM=");
});
