import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSubtotalMismatch } from "./audit-subtotal-basis.js";

const order = (over = {}) => ({
  subtotalNet: 100.0,
  subtotalGross: 122.0,
  lines: [{ totalPriceNet: 100.0, totalPriceGross: 122.0 }],
  ...over,
});

test("net expected and gross recorded is a mismatch", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: true }, 122.0);
  assert.equal(result.isMismatch, true);
  assert.equal(result.expectedBasis, "net");
  assert.equal(result.expected, 100.0);
  assert.equal(Math.round(result.delta * 100) / 100, 22.0);
});

test("net expected and net recorded is not a mismatch", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: true }, 100.0);
  assert.equal(result.isMismatch, false);
});

test("gross expected and net recorded is a mismatch", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: false }, 100.0);
  assert.equal(result.isMismatch, true);
  assert.equal(result.expectedBasis, "gross");
  assert.equal(result.expected, 122.0);
});

test("gross expected and gross recorded is not a mismatch", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: false }, 122.0);
  assert.equal(result.isMismatch, false);
});

test("within epsilon is not a mismatch", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: true }, 100.005, 0.01);
  assert.equal(result.isMismatch, false);
});

test("multi line order sums all lines for expected", () => {
  const multi = order({
    lines: [
      { totalPriceNet: 40.0, totalPriceGross: 48.8 },
      { totalPriceNet: 60.0, totalPriceGross: 73.2 },
    ],
  });
  const result = decideSubtotalMismatch(multi, { pricesEnteredWithTax: true }, 100.0);
  assert.equal(result.isMismatch, false);
  assert.equal(result.expected, 100.0);
});

test("zero delta is never a mismatch regardless of epsilon", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: true }, 100.0, 0.0);
  assert.equal(result.isMismatch, false);
  assert.equal(result.delta, 0.0);
});

test("expected basis reported matches tax config gross", () => {
  const result = decideSubtotalMismatch(order(), { pricesEnteredWithTax: false }, 0.0);
  assert.equal(result.expectedBasis, "gross");
});
