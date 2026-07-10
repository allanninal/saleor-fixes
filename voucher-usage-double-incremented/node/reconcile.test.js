import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVoucherUsageCorrection } from "./reconcile-voucher-usage.js";

const code = (over = {}) => ({ id: "Vm91Y2hlckNvZGU6MQ==", code: "SAVE10", storedUsed: 2, ...over });
const order = (over = {}) => ({ id: "T3JkZXI6MQ==", status: "UNFULFILLED", isPaid: true, ...over });

test("decrement when double incremented by a payment retry", () => {
  const result = decideVoucherUsageCorrection(code({ storedUsed: 2 }), [order()]);
  assert.deepEqual(result, { action: "decrement", correctedUsed: 1, delta: 1 });
});

test("none when stored matches real usage", () => {
  const result = decideVoucherUsageCorrection(code({ storedUsed: 1 }), [order()]);
  assert.deepEqual(result, { action: "none", correctedUsed: 1, delta: 0 });
});

test("none when stored is an undercount (out of scope)", () => {
  const orders = [order(), order({ id: "T3JkZXI6Mg==" })];
  const result = decideVoucherUsageCorrection(code({ storedUsed: 1 }), orders);
  assert.deepEqual(result, { action: "none", correctedUsed: 1, delta: 0 });
});

test("cancelled orders do not count toward real usage", () => {
  const orders = [order(), order({ id: "T3JkZXI6Mg==", status: "CANCELED", isPaid: false })];
  const result = decideVoucherUsageCorrection(code({ storedUsed: 2 }), orders);
  assert.deepEqual(result, { action: "decrement", correctedUsed: 1, delta: 1 });
});

test("paid but not yet a completed status still counts", () => {
  const orders = [order({ status: "UNCONFIRMED", isPaid: true })];
  const result = decideVoucherUsageCorrection(code({ storedUsed: 2 }), orders);
  assert.deepEqual(result, { action: "decrement", correctedUsed: 1, delta: 1 });
});

test("zero qualifying orders flags the full stored amount as delta", () => {
  const result = decideVoucherUsageCorrection(code({ storedUsed: 3 }), []);
  assert.deepEqual(result, { action: "decrement", correctedUsed: 0, delta: 3 });
});

test("partially fulfilled counts as real usage", () => {
  const orders = [order({ status: "PARTIALLY_FULFILLED", isPaid: false })];
  const result = decideVoucherUsageCorrection(code({ storedUsed: 1 }), orders);
  assert.deepEqual(result, { action: "none", correctedUsed: 1, delta: 0 });
});

test("no qualifying orders and zero stored is none", () => {
  const result = decideVoucherUsageCorrection(code({ storedUsed: 0 }), []);
  assert.deepEqual(result, { action: "none", correctedUsed: 0, delta: 0 });
});
