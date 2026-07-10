import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStuckOrder } from "./flag-stuck-unfulfilled.js";

const NOW = new Date("2026-07-10T00:00:00Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

const call = (over = {}) => classifyStuckOrder({
  status: "UNFULFILLED",
  isPaid: true,
  paymentChargeStatus: "FULLY_CHARGED",
  fulfillments: [],
  updatedAtIso: minutesAgo(60),
  nowIso: NOW.toISOString(),
  staleMinutes: 30,
  ...over,
});

test("stuck when paid, unfulfilled, no fulfillment, and stale", () => {
  const result = call();
  assert.equal(result.stuck, true);
  assert.equal(result.reason, "paid_but_no_fulfillment_past_threshold");
});

test("not stuck when status is not UNFULFILLED", () => {
  assert.deepEqual(call({ status: "FULFILLED" }), { stuck: false, reason: "not_unfulfilled" });
});

test("not stuck when PARTIALLY_FULFILLED", () => {
  assert.deepEqual(call({ status: "PARTIALLY_FULFILLED" }), { stuck: false, reason: "not_unfulfilled" });
});

test("not stuck when not paid", () => {
  const result = call({ isPaid: false, paymentChargeStatus: "NOT_CHARGED" });
  assert.deepEqual(result, { stuck: false, reason: "not_paid" });
});

test("paid via PARTIALLY_CHARGED still counts as paid", () => {
  const result = call({ isPaid: false, paymentChargeStatus: "PARTIALLY_CHARGED" });
  assert.equal(result.stuck, true);
});

test("not stuck when an active fulfillment exists", () => {
  const result = call({ fulfillments: [{ id: "Zg==", status: "FULFILLED" }] });
  assert.deepEqual(result, { stuck: false, reason: "has_active_fulfillment" });
});

test("stuck when the only fulfillment is cancelled", () => {
  const result = call({ fulfillments: [{ id: "Zg==", status: "CANCELED" }] });
  assert.equal(result.stuck, true);
});

test("not stuck when a mix of cancelled and active fulfillments exists", () => {
  const result = call({
    fulfillments: [
      { id: "Zg==", status: "CANCELED" },
      { id: "Zh==", status: "FULFILLED" },
    ],
  });
  assert.deepEqual(result, { stuck: false, reason: "has_active_fulfillment" });
});

test("not stuck within the normal processing window", () => {
  const result = call({ updatedAtIso: minutesAgo(5) });
  assert.deepEqual(result, { stuck: false, reason: "within_processing_window" });
});

test("exactly at the staleness threshold is stuck", () => {
  const result = call({ updatedAtIso: minutesAgo(30) });
  assert.equal(result.stuck, true);
});

test("isPaid true overrides a missing charge status", () => {
  const result = call({ isPaid: true, paymentChargeStatus: undefined });
  assert.equal(result.stuck, true);
});
