import { test } from "node:test";
import assert from "node:assert/strict";
import { diffVoucherDiscount } from "./detect-dropped-voucher.js";

const snapshot = (over = {}) => ({
  voucherCode: "SAVE10",
  totalGross: 90.0,
  undiscountedTotalGross: 100.0,
  ...over,
});

test("voucher preserved is not flagged", () => {
  const result = diffVoucherDiscount(snapshot(), snapshot());
  assert.equal(result.isDropped, false);
  assert.equal(result.delta, 0);
});

test("voucher fully dropped is flagged", () => {
  const completed = snapshot({ voucherCode: null, totalGross: 100.0 });
  const result = diffVoucherDiscount(snapshot(), completed);
  assert.equal(result.isDropped, true);
  assert.equal(result.expectedDiscount, 10.0);
  assert.equal(result.actualDiscount, 0.0);
});

test("voucher partially recalculated smaller is flagged", () => {
  const completed = snapshot({ totalGross: 97.0 });
  const result = diffVoucherDiscount(snapshot(), completed);
  assert.equal(result.isDropped, true);
  assert.equal(Math.round(result.delta * 100) / 100, 7.0);
});

test("no voucher applied on draft is not flagged", () => {
  const draft = snapshot({ voucherCode: null, totalGross: 100.0 });
  const completed = snapshot({ voucherCode: null, totalGross: 100.0 });
  const result = diffVoucherDiscount(draft, completed);
  assert.equal(result.isDropped, false);
});

test("rounding noise under tolerance is not flagged", () => {
  const completed = snapshot({ totalGross: 90.005 });
  const result = diffVoucherDiscount(snapshot(), completed, 0.01);
  assert.equal(result.isDropped, false);
});
