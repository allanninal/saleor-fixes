import { test } from "node:test";
import assert from "node:assert/strict";
import { isOrphanedDraftWithPayment } from "./flag-orphaned-drafts.js";

const order = (over = {}) => ({
  status: "DRAFT",
  payments: [{ id: "UGF5bWVudDox", isActive: true, chargeStatus: "FULLY_CHARGED" }],
  transactions: [],
  ...over,
});

test("flagged when draft with a charged active payment", () => {
  assert.equal(isOrphanedDraftWithPayment(order()), true);
});

test("flagged when draft with a transaction and no payment", () => {
  const o = order({ payments: [], transactions: [{ id: "VHJhbnNhY3Rpb25JdGVtOjE=" }] });
  assert.equal(isOrphanedDraftWithPayment(o), true);
});

test("not flagged when status is not DRAFT", () => {
  assert.equal(isOrphanedDraftWithPayment(order({ status: "UNFULFILLED" })), false);
});

test("not flagged when draft has no payment or transaction", () => {
  assert.equal(isOrphanedDraftWithPayment(order({ payments: [], transactions: [] })), false);
});

test("not flagged when payment is not charged", () => {
  const o = order({ payments: [{ id: "UGF5bWVudDox", isActive: true, chargeStatus: "NOT_CHARGED" }] });
  assert.equal(isOrphanedDraftWithPayment(o), false);
});

test("not flagged when payment is inactive", () => {
  const o = order({ payments: [{ id: "UGF5bWVudDox", isActive: false, chargeStatus: "FULLY_CHARGED" }] });
  assert.equal(isOrphanedDraftWithPayment(o), false);
});

test("flagged when multiple payments and only one qualifies", () => {
  const o = order({
    payments: [
      { id: "UGF5bWVudDox", isActive: false, chargeStatus: "FULLY_CHARGED" },
      { id: "UGF5bWVudDoy", isActive: true, chargeStatus: "PARTIALLY_CHARGED" },
    ],
  });
  assert.equal(isOrphanedDraftWithPayment(o), true);
});
