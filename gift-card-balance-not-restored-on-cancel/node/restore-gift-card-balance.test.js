import { test } from "node:test";
import assert from "node:assert/strict";
import { planGiftCardRestoration } from "./restore-gift-card-balance.js";

const order = (over = {}) => ({ id: "T3JkZXI6MQ==", status: "CANCELED", ...over });

const usage = (over = {}) => ({
  giftCardId: "R2lmdENhcmQ6MQ==",
  currentBalanceAmount: 0.0,
  initialBalanceAmount: 50.0,
  usedInOrderId: "T3JkZXI6MQ==",
  amountUsed: 50.0,
  alreadyRestored: false,
  ...over,
});

test("restores full amount when not already restored", () => {
  const plans = planGiftCardRestoration(order(), [usage()]);
  assert.deepEqual(plans, [{
    giftCardId: "R2lmdENhcmQ6MQ==",
    restoreToAmount: 50.0,
    reason: "order_cancelled_gift_card_not_refunded",
  }]);
});

test("no plan when order not cancelled", () => {
  const plans = planGiftCardRestoration(order({ status: "FULFILLED" }), [usage()]);
  assert.deepEqual(plans, []);
});

test("no plan when already restored", () => {
  const plans = planGiftCardRestoration(order(), [usage({ alreadyRestored: true })]);
  assert.deepEqual(plans, []);
});

test("no plan when amount used is zero", () => {
  const plans = planGiftCardRestoration(order(), [usage({ amountUsed: 0 })]);
  assert.deepEqual(plans, []);
});

test("no plan when amount used is negative", () => {
  const plans = planGiftCardRestoration(order(), [usage({ amountUsed: -5.0 })]);
  assert.deepEqual(plans, []);
});

test("no plan for usage on a different order", () => {
  const plans = planGiftCardRestoration(order(), [usage({ usedInOrderId: "T3JkZXI6OTk=" })]);
  assert.deepEqual(plans, []);
});

test("caps at initial balance within epsilon", () => {
  const plans = planGiftCardRestoration(
    order(),
    [usage({ currentBalanceAmount: 10.0, amountUsed: 40.0, initialBalanceAmount: 50.0 })]
  );
  assert.equal(plans[0].restoreToAmount, 50.0);
});

test("flags anomaly instead of clamping when overshoot is large", () => {
  const plans = planGiftCardRestoration(
    order(),
    [usage({ currentBalanceAmount: 20.0, amountUsed: 50.0, initialBalanceAmount: 50.0 })]
  );
  assert.deepEqual(plans, []);
});

test("tiny rounding overshoot is still allowed and capped", () => {
  const plans = planGiftCardRestoration(
    order(),
    [usage({ currentBalanceAmount: 0.005, amountUsed: 50.0, initialBalanceAmount: 50.0 })]
  );
  assert.equal(plans[0].restoreToAmount, 50.0);
});

test("multiple usages only restores the eligible one", () => {
  const usages = [
    usage({ giftCardId: "card-a", alreadyRestored: true }),
    usage({ giftCardId: "card-b", alreadyRestored: false }),
  ];
  const plans = planGiftCardRestoration(order(), usages);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].giftCardId, "card-b");
});

test("empty usages returns empty plan", () => {
  assert.deepEqual(planGiftCardRestoration(order(), []), []);
});
