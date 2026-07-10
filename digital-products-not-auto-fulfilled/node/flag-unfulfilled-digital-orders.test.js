import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoFulfill } from "./flag-unfulfilled-digital-orders.js";

const digitalLine = (over = {}) => ({
  is_shipping_required: false,
  digital_content: { use_default_settings: true, automatic_fulfillment: true },
  has_stock: true,
  ...over,
});

const order = (over = {}) => ({
  is_paid: true,
  status: "UNFULFILLED",
  paid_via: "CHECKOUT_CAPTURE",
  lines: [digitalLine()],
  ...over,
});

test("fully eligible case is true", () => {
  assert.equal(shouldAutoFulfill(order(), true), true);
});

test("paid via mark as paid is false even with flag on", () => {
  assert.equal(shouldAutoFulfill(order({ paid_via: "MARK_AS_PAID" }), true), false);
});

test("missing stock is false", () => {
  const o = order({ lines: [digitalLine({ has_stock: false })] });
  assert.equal(shouldAutoFulfill(o, true), false);
});

test("mixed digital and physical order is false", () => {
  const o = order({ lines: [digitalLine(), digitalLine({ is_shipping_required: true })] });
  assert.equal(shouldAutoFulfill(o, true), false);
});

test("per-content override disabled beats shop default on", () => {
  const o = order({
    lines: [digitalLine({ digital_content: { use_default_settings: false, automatic_fulfillment: false } })],
  });
  assert.equal(shouldAutoFulfill(o, true), false);
});

test("per-content override enabled beats shop default off", () => {
  const o = order({
    lines: [digitalLine({ digital_content: { use_default_settings: false, automatic_fulfillment: true } })],
  });
  assert.equal(shouldAutoFulfill(o, false), true);
});

test("not paid is false", () => {
  assert.equal(shouldAutoFulfill(order({ is_paid: false }), true), false);
});

test("already fulfilled status is false", () => {
  assert.equal(shouldAutoFulfill(order({ status: "FULFILLED" }), true), false);
});

test("no lines is false", () => {
  assert.equal(shouldAutoFulfill(order({ lines: [] }), true), false);
});

test("missing digital content is false", () => {
  const o = order({ lines: [digitalLine({ digital_content: null })] });
  assert.equal(shouldAutoFulfill(o, true), false);
});

test("partially fulfilled status is eligible", () => {
  assert.equal(shouldAutoFulfill(order({ status: "PARTIALLY_FULFILLED" }), true), true);
});
