import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingChannelListings } from "./find-missing-listings.js";

const V1 = "gid://saleor/ProductVariant/1";
const V2 = "gid://saleor/ProductVariant/2";
const V3 = "gid://saleor/ProductVariant/3";

test("no gap when variant has all channels", () => {
  const variantChannelListings = { [V1]: ["default-channel", "b2b"] };
  const result = findMissingChannelListings([V1], variantChannelListings, ["default-channel", "b2b"]);
  assert.deepEqual(result, {});
});

test("gap when variant missing one channel", () => {
  const variantChannelListings = { [V1]: ["default-channel"] };
  const result = findMissingChannelListings([V1], variantChannelListings, ["default-channel", "b2b"]);
  assert.deepEqual(result, { [V1]: ["b2b"] });
});

test("gap when variant has no listings at all", () => {
  const variantChannelListings = {};
  const result = findMissingChannelListings([V2], variantChannelListings, ["default-channel"]);
  assert.deepEqual(result, { [V2]: ["default-channel"] });
});

test("missing slugs are sorted", () => {
  const variantChannelListings = { [V1]: [] };
  const result = findMissingChannelListings([V1], variantChannelListings, ["b2b", "default-channel", "aa-region"]);
  assert.deepEqual(result[V1], ["aa-region", "b2b", "default-channel"]);
});

test("multiple variants get independent results", () => {
  const variantChannelListings = { [V1]: ["default-channel"], [V2]: ["default-channel", "b2b"] };
  const result = findMissingChannelListings([V1, V2, V3], variantChannelListings, ["default-channel", "b2b"]);
  assert.deepEqual(result, { [V1]: ["b2b"], [V3]: ["b2b", "default-channel"] });
});

test("only flags channels the product is actually listed in", () => {
  const variantChannelListings = { [V1]: ["default-channel"] };
  const result = findMissingChannelListings([V1], variantChannelListings, ["default-channel"]);
  assert.deepEqual(result, {});
});

test("variant not in imported ids is ignored", () => {
  const variantChannelListings = { [V1]: [], [V2]: [] };
  const result = findMissingChannelListings([V1], variantChannelListings, ["default-channel"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result, V2), false);
});
