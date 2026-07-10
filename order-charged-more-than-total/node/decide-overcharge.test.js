import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOverchargeFlag } from "./flag-overcharged-orders.js";

const order = (over = {}) => ({
  totalGrossAmount: 100.0,
  totalCharged: 100.0,
  totalAuthorized: 0.0,
  currency: "USD",
  ...over,
});

test("exact match is not overcharged", () => {
  const result = decideOverchargeFlag(order(), [{ chargedAmount: 100.0, authorizedAmount: 0.0 }]);
  assert.equal(result.isOvercharged, false);
  assert.equal(result.capturedPlusAuthorized, 100.0);
  assert.equal(result.overageAmount, 0);
});

test("one cent over is overcharged", () => {
  const result = decideOverchargeFlag(order(), [{ chargedAmount: 100.01, authorizedAmount: 0.0 }]);
  assert.equal(result.isOvercharged, true);
  assert.equal(Math.round(result.overageAmount * 100) / 100, 0.01);
});

test("within epsilon is not overcharged", () => {
  const result = decideOverchargeFlag(order(), [{ chargedAmount: 100.003, authorizedAmount: 0.0 }], 0.005);
  assert.equal(result.isOvercharged, false);
});

test("double capture is overcharged", () => {
  const transactions = [
    { chargedAmount: 100.0, authorizedAmount: 0.0 },
    { chargedAmount: 100.0, authorizedAmount: 0.0 },
  ];
  const result = decideOverchargeFlag(order(), transactions);
  assert.equal(result.isOvercharged, true);
  assert.equal(result.capturedPlusAuthorized, 200.0);
  assert.equal(Math.round(result.overageAmount * 100) / 100, 100.0);
});

test("zero total with any charge is overcharged", () => {
  const result = decideOverchargeFlag(order({ totalGrossAmount: 0.0 }), [{ chargedAmount: 5.0, authorizedAmount: 0.0 }]);
  assert.equal(result.isOvercharged, true);
});

test("falls back to order totals when no transactions array", () => {
  const result = decideOverchargeFlag(order({ totalCharged: 150.0, totalAuthorized: 0.0 }), []);
  assert.equal(result.isOvercharged, true);
  assert.equal(result.capturedPlusAuthorized, 150.0);
});

test("authorized plus charged together can overcharge", () => {
  const transactions = [{ chargedAmount: 80.0, authorizedAmount: 25.0 }];
  const result = decideOverchargeFlag(order(), transactions);
  assert.equal(result.isOvercharged, true);
  assert.equal(result.capturedPlusAuthorized, 105.0);
});

test("zero charge and zero total is not overcharged", () => {
  const result = decideOverchargeFlag(order({ totalGrossAmount: 0.0 }), [{ chargedAmount: 0.0, authorizedAmount: 0.0 }]);
  assert.equal(result.isOvercharged, false);
  assert.equal(result.overageAmount, 0);
});

test("empty transactions list falls back to order totals", () => {
  const result = decideOverchargeFlag(order({ totalCharged: 100.0, totalAuthorized: 10.0 }), []);
  assert.equal(result.isOvercharged, true);
  assert.equal(result.capturedPlusAuthorized, 110.0);
});
