import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBalanceDrift } from "./flag-balance-drift.js";

test("OK when balance matches expected", () => {
  const result = classifyBalanceDrift(100.0, 100.0, 0.0, 0.0);
  assert.equal(result.status, "OK");
  assert.equal(result.driftedBy, 0);
});

test("OK with legitimate partial balance", () => {
  const result = classifyBalanceDrift(100.0, 60.0, 0.0, 40.0);
  assert.equal(result.status, "OK");
});

test("drifted when partial refund leaves charged amount stale", () => {
  const result = classifyBalanceDrift(100.0, 100.0, 30.0, 0.0);
  assert.equal(result.status, "BALANCE_DRIFTED");
  assert.equal(result.expectedBalance, 30.0);
  assert.equal(result.driftedBy, -30.0);
});

test("drifted when authorization adjustment has no capture", () => {
  const result = classifyBalanceDrift(200.0, 150.0, 0.0, 75.0);
  assert.equal(result.status, "BALANCE_DRIFTED");
  assert.equal(result.expectedBalance, 50.0);
  assert.equal(result.driftedBy, 25.0);
});

test("floating point rounding within epsilon is OK", () => {
  const result = classifyBalanceDrift(99.995, 100.0, 0.0, 0.0);
  assert.equal(result.status, "OK");
});

test("driftedBy is signed and reports direction", () => {
  const overReported = classifyBalanceDrift(100.0, 100.0, 0.0, 10.0);
  const underReported = classifyBalanceDrift(100.0, 100.0, 0.0, -10.0);
  assert.equal(overReported.driftedBy, 10.0);
  assert.equal(underReported.driftedBy, -10.0);
});

test("OK when fully refunded and balance equals total", () => {
  const result = classifyBalanceDrift(100.0, 100.0, 100.0, 100.0);
  assert.equal(result.status, "OK");
});
