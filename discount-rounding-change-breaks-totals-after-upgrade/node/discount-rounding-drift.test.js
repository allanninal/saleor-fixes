import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDiscountDrift } from "./discount-rounding-drift.js";

test("Saleor documented example is drifted", () => {
  // 12.5% off 13.00 was 1.62 under ROUND_DOWN, is 1.63 under ROUND_HALF_UP
  const result = computeDiscountDrift({
    undiscountedAmount: 13.00,
    discountValueType: "PERCENTAGE",
    discountValue: 12.5,
    persistedDiscountAmount: 1.62,
  });
  assert.equal(result.expectedDiscountAmount, 1.63);
  assert.equal(Math.round(result.delta * 100) / 100, 0.01);
  assert.equal(result.isDrifted, true);
});

test("matches when already recomputed", () => {
  const result = computeDiscountDrift({
    undiscountedAmount: 13.00,
    discountValueType: "PERCENTAGE",
    discountValue: 12.5,
    persistedDiscountAmount: 1.63,
  });
  assert.equal(result.isDrifted, false);
  assert.equal(Math.round(result.delta * 100) / 100, 0);
});

test("FIXED voucher is never drifted", () => {
  const result = computeDiscountDrift({
    undiscountedAmount: 13.00,
    discountValueType: "FIXED",
    discountValue: 5.00,
    persistedDiscountAmount: 999.99, // deliberately wrong, still ignored
  });
  assert.equal(result.isDrifted, false);
});

test("clean percentage with no rounding edge is not drifted", () => {
  const result = computeDiscountDrift({
    undiscountedAmount: 20.00,
    discountValueType: "PERCENTAGE",
    discountValue: 10,
    persistedDiscountAmount: 2.00,
  });
  assert.equal(result.isDrifted, false);
});

test("delta direction is expected minus persisted", () => {
  const result = computeDiscountDrift({
    undiscountedAmount: 13.00,
    discountValueType: "PERCENTAGE",
    discountValue: 12.5,
    persistedDiscountAmount: 1.70, // persisted higher than expected
  });
  assert.equal(Math.round(result.delta * 100) / 100, -0.07);
  assert.equal(result.isDrifted, true);
});

test("drift threshold is exactly one minor unit", () => {
  const result = computeDiscountDrift({
    undiscountedAmount: 100.00,
    discountValueType: "PERCENTAGE",
    discountValue: 10,
    persistedDiscountAmount: 9.99,
  });
  assert.equal(result.expectedDiscountAmount, 10.00);
  assert.equal(result.isDrifted, true);
});

test("custom currency decimal places is respected", () => {
  const result = computeDiscountDrift({
    undiscountedAmount: 13.00,
    discountValueType: "PERCENTAGE",
    discountValue: 12.5,
    persistedDiscountAmount: 1.6,
    currencyDecimalPlaces: 1,
  });
  assert.equal(result.expectedDiscountAmount, 1.6);
  assert.equal(result.isDrifted, false);
});
