import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGiftCardBalanceOverwrite } from "./audit-gift-card-balances.js";

const event = (over = {}) => ({
  type: "UPDATED",
  oldInitialBalanceAmount: null,
  oldCurrentBalanceAmount: null,
  newInitialBalanceAmount: null,
  newCurrentBalanceAmount: null,
  ...over,
});

const card = (over = {}) => ({ initialBalanceAmount: 50, currentBalanceAmount: 50, events: [], ...over });

test("not affected for a healthy untouched card", () => {
  const result = classifyGiftCardBalanceOverwrite(card());
  assert.deepEqual(result, { affected: false, reason: null, recoveredCurrentBalanceAmount: null });
});

test("current exceeds initial is unrecoverable", () => {
  const result = classifyGiftCardBalanceOverwrite(card({ initialBalanceAmount: 50, currentBalanceAmount: 60 }));
  assert.deepEqual(result, { affected: true, reason: "current_exceeds_initial", recoveredCurrentBalanceAmount: null });
});

test("update reset a spent card recovers old current balance", () => {
  const c = card({
    initialBalanceAmount: 60,
    currentBalanceAmount: 60,
    events: [event({ oldInitialBalanceAmount: 50, oldCurrentBalanceAmount: 12, newInitialBalanceAmount: 60, newCurrentBalanceAmount: 60 })],
  });
  const result = classifyGiftCardBalanceOverwrite(c);
  assert.deepEqual(result, { affected: true, reason: "update_reset_spent_card", recoveredCurrentBalanceAmount: 12 });
});

test("update on a never spent card is not flagged", () => {
  const c = card({
    initialBalanceAmount: 60,
    currentBalanceAmount: 60,
    events: [event({ oldInitialBalanceAmount: 50, oldCurrentBalanceAmount: 50, newInitialBalanceAmount: 60, newCurrentBalanceAmount: 60 })],
  });
  const result = classifyGiftCardBalanceOverwrite(c);
  assert.deepEqual(result, { affected: false, reason: null, recoveredCurrentBalanceAmount: null });
});

test("update that keeps balances apart is not flagged", () => {
  const c = card({
    initialBalanceAmount: 50,
    currentBalanceAmount: 20,
    events: [event({ oldInitialBalanceAmount: 50, oldCurrentBalanceAmount: 30, newInitialBalanceAmount: 50, newCurrentBalanceAmount: 20 })],
  });
  const result = classifyGiftCardBalanceOverwrite(c);
  assert.deepEqual(result, { affected: false, reason: null, recoveredCurrentBalanceAmount: null });
});

test("events with missing balance data are skipped, not crashed", () => {
  const c = card({ events: [event({ type: "ISSUED" })] });
  const result = classifyGiftCardBalanceOverwrite(c);
  assert.deepEqual(result, { affected: false, reason: null, recoveredCurrentBalanceAmount: null });
});

test("earliest matching update wins when scanning chronologically", () => {
  const c = card({
    initialBalanceAmount: 60,
    currentBalanceAmount: 60,
    events: [
      event({ oldInitialBalanceAmount: 50, oldCurrentBalanceAmount: 12, newInitialBalanceAmount: 60, newCurrentBalanceAmount: 60 }),
      event({ oldInitialBalanceAmount: 60, oldCurrentBalanceAmount: 12, newInitialBalanceAmount: 90, newCurrentBalanceAmount: 90 }),
    ],
  });
  const result = classifyGiftCardBalanceOverwrite(c);
  assert.equal(result.recoveredCurrentBalanceAmount, 12);
});

test("current exceeds initial takes priority over event scan", () => {
  const c = card({
    initialBalanceAmount: 40,
    currentBalanceAmount: 45,
    events: [event({ oldInitialBalanceAmount: 40, oldCurrentBalanceAmount: 40, newInitialBalanceAmount: 40, newCurrentBalanceAmount: 40 })],
  });
  const result = classifyGiftCardBalanceOverwrite(c);
  assert.deepEqual(result, { affected: true, reason: "current_exceeds_initial", recoveredCurrentBalanceAmount: null });
});
