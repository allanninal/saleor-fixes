import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStaleShipping } from "./reconcile-stale-shipping.js";

const METHOD_A = { id: "U2hpcHBpbmdNZXRob2Q6MQ==" };
const METHOD_B = { id: "U2hpcHBpbmdNZXRob2Q6Mg==" };

test("not stale when old method still in fresh list", () => {
  const result = decideStaleShipping(METHOD_A.id, [METHOD_A, METHOD_B], []);
  assert.deepEqual(result, { isStale: false, replacementId: METHOD_A.id });
});

test("stale when old method missing from fresh list", () => {
  const result = decideStaleShipping(METHOD_A.id, [METHOD_B], []);
  assert.deepEqual(result, { isStale: true, replacementId: METHOD_B.id });
});

test("stale with no replacement when fresh list empty", () => {
  const result = decideStaleShipping(METHOD_A.id, [], []);
  assert.deepEqual(result, { isStale: true, replacementId: null });
});

test("not stale when old method id is null", () => {
  const result = decideStaleShipping(null, [METHOD_A], []);
  assert.deepEqual(result, { isStale: false, replacementId: null });
});

test("stale when problems report delivery method stale", () => {
  const problems = [{ __typename: "CheckoutProblemDeliveryMethodStale" }];
  const result = decideStaleShipping(METHOD_A.id, [METHOD_A], problems);
  assert.deepEqual(result, { isStale: true, replacementId: METHOD_A.id });
});

test("stale when problems report delivery method invalid", () => {
  const problems = [{ __typename: "CheckoutProblemDeliveryMethodInvalid" }];
  const result = decideStaleShipping(METHOD_A.id, [METHOD_A, METHOD_B], problems);
  assert.deepEqual(result, { isStale: true, replacementId: METHOD_A.id });
});

test("unrelated problem types do not trigger staleness", () => {
  const problems = [{ __typename: "CheckoutProblemInsufficientStock" }];
  const result = decideStaleShipping(METHOD_A.id, [METHOD_A], problems);
  assert.deepEqual(result, { isStale: false, replacementId: METHOD_A.id });
});

test("null old method with stale problem reports stale with no replacement", () => {
  const problems = [{ __typename: "CheckoutProblemDeliveryMethodStale" }];
  const result = decideStaleShipping(null, [], problems);
  assert.deepEqual(result, { isStale: true, replacementId: null });
});
