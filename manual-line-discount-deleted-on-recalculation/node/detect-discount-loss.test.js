import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDiscountLoss } from "./detect-discount-loss.js";

const beforeLine = (over = {}) => ({
  unitDiscountType: "FIXED",
  unitDiscountValue: 5.0,
  unitDiscountReason: "Loyalty discount",
  unitPriceGrossAmount: 15.0,
  ...over,
});

const afterLine = (over = {}) => ({
  unitDiscountType: "FIXED",
  unitDiscountValue: 5.0,
  unitDiscountReason: "Loyalty discount",
  unitPriceGrossAmount: 15.0,
  undiscountedUnitPriceGrossAmount: 20.0,
  ...over,
});

test("no loss when discount unchanged", () => {
  const decision = decideDiscountLoss(beforeLine(), afterLine());
  assert.deepEqual(decision, { lost: false, shouldFlag: false, restoreInput: null });
});

test("loss when value and reason both cleared", () => {
  const after = afterLine({ unitDiscountValue: 0, unitDiscountReason: null, unitPriceGrossAmount: 20.0 });
  const decision = decideDiscountLoss(beforeLine(), after);
  assert.equal(decision.lost, true);
  assert.equal(decision.shouldFlag, true);
  assert.deepEqual(decision.restoreInput, { valueType: "FIXED", value: 5.0, reason: "Loyalty discount" });
});

test("no loss when line never had a manual discount", () => {
  const before = beforeLine({ unitDiscountValue: 0, unitDiscountReason: null });
  const after = afterLine({ unitDiscountValue: 0, unitDiscountReason: null, unitPriceGrossAmount: 20.0 });
  const decision = decideDiscountLoss(before, after);
  assert.equal(decision.lost, false);
  assert.equal(decision.restoreInput, null);
});

test("no loss when value present but reason still set", () => {
  const after = afterLine({ unitDiscountValue: 0, unitDiscountReason: "Loyalty discount" });
  const decision = decideDiscountLoss(beforeLine(), after);
  assert.equal(decision.lost, false);
});

test("no loss when reason cleared but value survives", () => {
  const after = afterLine({ unitDiscountValue: 5.0, unitDiscountReason: null });
  const decision = decideDiscountLoss(beforeLine(), after);
  assert.equal(decision.lost, false);
});

test("restore input uses percentage type from before", () => {
  const before = beforeLine({ unitDiscountType: "PERCENTAGE", unitDiscountValue: 10.0 });
  const after = afterLine({ unitDiscountValue: 0, unitDiscountReason: null, unitPriceGrossAmount: 20.0 });
  const decision = decideDiscountLoss(before, after);
  assert.equal(decision.restoreInput.valueType, "PERCENTAGE");
  assert.equal(decision.restoreInput.value, 10.0);
});

test("loss detected from reason alone when value was zero", () => {
  // A merchant can apply a manual discount with a reason but a zero value
  // (e.g. documenting a price match at the same price). Losing the reason
  // alone still counts as losing the manual discount.
  const before = beforeLine({ unitDiscountValue: 0, unitDiscountReason: "Price match" });
  const after = afterLine({ unitDiscountValue: 0, unitDiscountReason: null, unitPriceGrossAmount: 15.0 });
  const decision = decideDiscountLoss(before, after);
  assert.equal(decision.lost, true);
  assert.deepEqual(decision.restoreInput, { valueType: "FIXED", value: 0, reason: "Price match" });
});
