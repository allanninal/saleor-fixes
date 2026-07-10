import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeExpectedEntireOrderPercentageDiscount,
  actualVoucherDiscount,
  hasStackedPromotionAndVoucher,
  flagOrder,
} from "./flag-entire-order-voucher-mismatch.js";

test("simple percentage off subtotal", () => {
  assert.equal(computeExpectedEntireOrderPercentageDiscount(100.0, 10, false), 10.0);
});

test("issue 17453 scenario is non zero", () => {
  // 40% catalogue promotion already brought the subtotal to 60, then a 70%
  // entire order voucher applies to that already-discounted subtotal.
  const subtotalAfterPromotion = 60.0;
  const expected = computeExpectedEntireOrderPercentageDiscount(subtotalAfterPromotion, 70, false);
  assert.equal(expected, 42.0);
  assert.notEqual(expected, 0.0);
});

test("discount never exceeds subtotal", () => {
  assert.equal(computeExpectedEntireOrderPercentageDiscount(50.0, 150, false), 50.0);
});

test("apply once per order uses cheapest unit", () => {
  const expected = computeExpectedEntireOrderPercentageDiscount(100.0, 20, true, 15.0);
  assert.equal(expected, 3.0);
});

test("apply once per order with no cheapest price is zero", () => {
  const expected = computeExpectedEntireOrderPercentageDiscount(100.0, 20, true, undefined);
  assert.equal(expected, 0.0);
});

const order = (over = {}) => ({
  id: "T3JkZXI6MQ==",
  number: "1001",
  subtotal: { gross: { amount: 60.0 } },
  undiscountedTotal: { gross: { amount: 100.0 } },
  total: { gross: { amount: 60.0 } },
  channel: { slug: "default-channel" },
  voucher: {
    id: "Vm91Y2hlcjox",
    type: "ENTIRE_ORDER",
    discountValueType: "PERCENTAGE",
    channelListings: [{ channel: { slug: "default-channel" }, discountValue: 70 }],
  },
  discounts: [{ type: "VOUCHER", value: 70, valueType: "PERCENTAGE", amount: { amount: 42.0 } }],
  lines: [{ id: "TGluZTox", unitDiscountAmount: 4.0, unitDiscountType: "PERCENTAGE",
             undiscountedUnitPrice: { gross: { amount: 10.0 } } }],
  ...over,
});

test("matching order is not flagged", () => {
  assert.equal(flagOrder(order()), null);
});

test("mismatched order is flagged with details", () => {
  const bad = order({ discounts: [{ type: "VOUCHER", value: 70, valueType: "PERCENTAGE", amount: { amount: 70.0 } }] });
  const finding = flagOrder(bad);
  assert.notEqual(finding, null);
  assert.equal(finding.orderNumber, "1001");
  assert.equal(finding.expectedDiscount, 42.0);
  assert.equal(finding.actualDiscount, 70.0);
  assert.equal(Math.round(finding.delta * 100) / 100, 28.0);
  assert.equal(finding.stackedWithPromotion, true);
});

test("no matching channel listing is skipped", () => {
  const o = order({ channel: { slug: "other-channel" } });
  assert.equal(flagOrder(o), null);
});

test("actual voucher discount falls back to total gap", () => {
  const o = order({ discounts: [] });
  assert.equal(actualVoucherDiscount(o), 40.0);
});

test("hasStackedPromotionAndVoucher detects line discount", () => {
  assert.equal(hasStackedPromotionAndVoucher(order()), true);
  assert.equal(hasStackedPromotionAndVoucher(order({ lines: [] })), false);
});

test("delta within tolerance is not flagged", () => {
  const closeEnough = order({ discounts: [{ type: "VOUCHER", value: 70, valueType: "PERCENTAGE", amount: { amount: 42.005 } }] });
  assert.equal(flagOrder(closeEnough), null);
});
