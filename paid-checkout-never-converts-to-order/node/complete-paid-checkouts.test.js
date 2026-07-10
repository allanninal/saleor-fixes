import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCompleteCheckout } from "./complete-paid-checkouts.js";

const NOW = "2026-07-10T00:30:00.000Z";

const checkout = (over = {}) => ({
  hasOrder: false,
  authorizeStatus: "FULL",
  chargeStatus: "FULL",
  createdAt: "2026-07-10T00:20:00.000Z",
  ...over,
});

test("completes when paid, aged, and no order", () => {
  assert.equal(shouldCompleteCheckout(checkout(), NOW, 5).action, "complete");
});

test("skips when already has an order", () => {
  assert.equal(shouldCompleteCheckout(checkout({ hasOrder: true }), NOW, 5).action, "skip");
});

test("skips when not fully authorized", () => {
  assert.equal(shouldCompleteCheckout(checkout({ authorizeStatus: "PARTIAL" }), NOW, 5).action, "skip");
});

test("skips when no authorization yet", () => {
  assert.equal(shouldCompleteCheckout(checkout({ authorizeStatus: "NONE" }), NOW, 5).action, "skip");
});

test("skips when too new", () => {
  assert.equal(shouldCompleteCheckout(checkout({ createdAt: "2026-07-10T00:27:00.000Z" }), NOW, 5).action, "skip");
});

test("flags when charge status is pending", () => {
  assert.equal(shouldCompleteCheckout(checkout({ chargeStatus: "PENDING" }), NOW, 5).action, "flag");
});

test("flags when charge status is partial", () => {
  assert.equal(shouldCompleteCheckout(checkout({ chargeStatus: "PARTIAL" }), NOW, 5).action, "flag");
});

test("exactly at grace period completes", () => {
  assert.equal(shouldCompleteCheckout(checkout({ createdAt: "2026-07-10T00:25:00.000Z" }), NOW, 5).action, "complete");
});
