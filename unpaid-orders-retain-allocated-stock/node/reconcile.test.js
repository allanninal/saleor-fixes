import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStuckOrder, hasOpenAllocation } from "./reconcile-stuck-orders.js";

const NOW = new Date("2026-07-10T00:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

const order = (over = {}) => ({
  status: "UNFULFILLED",
  isPaid: false,
  paymentStatus: "NOT_CHARGED",
  createdAt: hoursAgo(100),
  channelExpireOrdersAfterMin: null,
  ...over,
});

test("OK when already paid", () => {
  assert.equal(classifyStuckOrder(order({ isPaid: true }), NOW, 72), "OK");
});

test("OK when already cancelled", () => {
  assert.equal(classifyStuckOrder(order({ status: "CANCELED" }), NOW, 72), "OK");
});

test("OK when already expired", () => {
  assert.equal(classifyStuckOrder(order({ status: "EXPIRED" }), NOW, 72), "OK");
});

test("OK when already fulfilled", () => {
  assert.equal(classifyStuckOrder(order({ status: "FULFILLED" }), NOW, 72), "OK");
});

test("OK when recent", () => {
  assert.equal(classifyStuckOrder(order({ createdAt: hoursAgo(10) }), NOW, 72), "OK");
});

test("CANCEL when unfulfilled, stale, and unpaid", () => {
  assert.equal(classifyStuckOrder(order(), NOW, 72), "CANCEL");
});

test("CANCEL when unconfirmed and no native expiration configured", () => {
  const o = order({ status: "UNCONFIRMED", channelExpireOrdersAfterMin: null });
  assert.equal(classifyStuckOrder(o, NOW, 72), "CANCEL");
});

test("OK when unconfirmed and native expiration has not elapsed", () => {
  const o = order({ status: "UNCONFIRMED", channelExpireOrdersAfterMin: 999999, createdAt: hoursAgo(100) });
  assert.equal(classifyStuckOrder(o, NOW, 72), "OK");
});

test("CANCEL when unconfirmed and native expiration already elapsed", () => {
  const o = order({ status: "UNCONFIRMED", channelExpireOrdersAfterMin: 60, createdAt: hoursAgo(100) });
  assert.equal(classifyStuckOrder(o, NOW, 72), "CANCEL");
});

test("DEALLOCATE_ONLY when partially fulfilled", () => {
  assert.equal(classifyStuckOrder(order({ status: "PARTIALLY_FULFILLED" }), NOW, 72), "DEALLOCATE_ONLY");
});

test("OK when payment status is not one of the unpaid states", () => {
  assert.equal(classifyStuckOrder(order({ paymentStatus: "FULLY_CHARGED" }), NOW, 72), "OK");
});

test("OK when exactly at stale boundary, not yet over", () => {
  assert.equal(classifyStuckOrder(order({ createdAt: hoursAgo(72) }), NOW, 72), "OK");
});

test("CANCEL when just over stale boundary", () => {
  const justOver = new Date(NOW.getTime() - (72 * 3600000 + 60000)).toISOString();
  assert.equal(classifyStuckOrder(order({ createdAt: justOver }), NOW, 72), "CANCEL");
});

test("hasOpenAllocation is true when a line has unfulfilled quantity", () => {
  const withLines = { lines: [{ quantity: 3, quantityFulfilled: 1 }] };
  assert.equal(hasOpenAllocation(withLines), true);
});

test("hasOpenAllocation is false when every line is fully fulfilled", () => {
  const withLines = { lines: [{ quantity: 3, quantityFulfilled: 3 }] };
  assert.equal(hasOpenAllocation(withLines), false);
});

test("hasOpenAllocation is false when there are no lines", () => {
  assert.equal(hasOpenAllocation({ lines: [] }), false);
});
