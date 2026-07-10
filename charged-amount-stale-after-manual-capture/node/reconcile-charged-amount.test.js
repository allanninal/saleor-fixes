import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChargeReconciliation } from "./reconcile-charged-amount.js";

const saleorTxn = (over = {}) => ({ chargedAmount: 0, chargePendingAmount: 100, events: [], ...over });
const gateway = (over = {}) => ({ pspReference: "psp_1", capturedAmount: 100, status: "succeeded", ...over });

test("pending gateway is in sync", () => {
  assert.equal(classifyChargeReconciliation(saleorTxn(), gateway({ status: "pending" })), "IN_SYNC");
});

test("succeeded with no matching event needs report success", () => {
  assert.equal(classifyChargeReconciliation(saleorTxn({ chargedAmount: 0 }), gateway()), "NEEDS_REPORT_SUCCESS");
});

test("succeeded with matching event is in sync", () => {
  const txn = saleorTxn({ chargedAmount: 100, events: [{ type: "CHARGE_SUCCESS", pspReference: "psp_1" }] });
  assert.equal(classifyChargeReconciliation(txn, gateway()), "IN_SYNC");
});

test("saleor over-reports flags mismatch", () => {
  const txn = saleorTxn({ chargedAmount: 150, events: [] });
  assert.equal(classifyChargeReconciliation(txn, gateway()), "AMOUNT_MISMATCH_FLAG");
});

test("failed gateway with open pending needs report failure", () => {
  const txn = saleorTxn({ chargePendingAmount: 100 });
  assert.equal(classifyChargeReconciliation(txn, gateway({ status: "failed" })), "NEEDS_REPORT_FAILURE");
});

test("failed gateway with no pending is in sync", () => {
  const txn = saleorTxn({ chargePendingAmount: 0 });
  assert.equal(classifyChargeReconciliation(txn, gateway({ status: "failed" })), "IN_SYNC");
});

test("different pspReference on event still needs report", () => {
  const txn = saleorTxn({ chargedAmount: 0, events: [{ type: "CHARGE_SUCCESS", pspReference: "some_other_psp" }] });
  assert.equal(classifyChargeReconciliation(txn, gateway()), "NEEDS_REPORT_SUCCESS");
});

test("wrong event type still needs report", () => {
  const txn = saleorTxn({ chargedAmount: 0, events: [{ type: "CHARGE_FAILURE", pspReference: "psp_1" }] });
  assert.equal(classifyChargeReconciliation(txn, gateway()), "NEEDS_REPORT_SUCCESS");
});
