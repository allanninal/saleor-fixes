import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrderCapture } from "./flag-over-captured.js";

const tx = (id, chargedAmount, pspReference = "psp_1") => ({ id, pspReference, chargedAmount });

test("OK when single correct capture", () => {
  const result = classifyOrderCapture(100.0, [tx("t1", 100.0)]);
  assert.equal(result.status, "OK");
  assert.equal(result.overBy, 0);
  assert.deepEqual(result.culprits, []);
});

test("OVER_CAPTURED when two full amount transactions", () => {
  const result = classifyOrderCapture(100.0, [tx("t1", 100.0, "psp_1"), tx("t2", 100.0, "psp_2")]);
  assert.equal(result.status, "OVER_CAPTURED");
  assert.equal(result.totalCaptured, 200.0);
  assert.equal(result.overBy, 100.0);
  assert.deepEqual(result.culprits, ["t1", "t2"]);
});

test("OK with partial capture and refund netting to total", () => {
  const result = classifyOrderCapture(100.0, [tx("t1", 60.0), tx("t2", 40.0)]);
  assert.equal(result.status, "OK");
});

test("OVER_CAPTURED with partial plus full duplicate", () => {
  const result = classifyOrderCapture(50.0, [tx("t1", 50.0, "psp_1"), tx("t2", 50.0, "psp_2")]);
  assert.equal(result.status, "OVER_CAPTURED");
  assert.equal(result.overBy, 50.0);
  assert.deepEqual(result.culprits, ["t1", "t2"]);
});

test("floating point rounding within epsilon is OK", () => {
  const result = classifyOrderCapture(99.99, [tx("t1", 100.0)]);
  assert.equal(result.status, "OK");
});

test("culprits sorted by charged amount descending", () => {
  const result = classifyOrderCapture(100.0, [
    tx("small", 5.0),
    tx("big1", 100.0, "psp_1"),
    tx("big2", 150.0, "psp_2"),
  ]);
  assert.equal(result.status, "OVER_CAPTURED");
  assert.deepEqual(result.culprits, ["big2", "big1"]);
});

test("no culprits when over-captured from many small transactions", () => {
  const result = classifyOrderCapture(100.0, [tx("t1", 60.0), tx("t2", 60.0)]);
  assert.equal(result.status, "OVER_CAPTURED");
  assert.equal(result.overBy, 20.0);
  assert.deepEqual(result.culprits, []);
});
