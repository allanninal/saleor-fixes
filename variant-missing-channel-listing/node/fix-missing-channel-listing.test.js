import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findVariantsMissingChannelListing,
  findSiblingPrice,
  resolvePrice,
} from "./fix-missing-channel-listing.js";

const variant = (over = {}) => ({
  id: "gid://saleor/ProductVariant/1",
  sku: "SKU-1",
  productChannelSlugs: ["default-channel", "us"],
  variantChannelSlugs: ["default-channel"],
  ...over,
});

test("flags variant missing a channel", () => {
  const result = findVariantsMissingChannelListing([variant()]);
  assert.deepEqual(result, [{ id: "gid://saleor/ProductVariant/1", sku: "SKU-1", missingChannels: ["us"] }]);
});

test("no flag when fully listed", () => {
  const result = findVariantsMissingChannelListing([
    variant({ variantChannelSlugs: ["default-channel", "us"] }),
  ]);
  assert.deepEqual(result, []);
});

test("no flag when product has no published channels", () => {
  const result = findVariantsMissingChannelListing([
    variant({ productChannelSlugs: [], variantChannelSlugs: [] }),
  ]);
  assert.deepEqual(result, []);
});

test("flags variant with zero channel listings", () => {
  const result = findVariantsMissingChannelListing([variant({ variantChannelSlugs: [] })]);
  assert.deepEqual(result, [
    { id: "gid://saleor/ProductVariant/1", sku: "SKU-1", missingChannels: ["default-channel", "us"] },
  ]);
});

test("multiple variants mixed results", () => {
  const ok = variant({ id: "gid://saleor/ProductVariant/2", sku: "SKU-2", variantChannelSlugs: ["default-channel", "us"] });
  const bad = variant({ id: "gid://saleor/ProductVariant/3", sku: "SKU-3", variantChannelSlugs: [] });
  const result = findVariantsMissingChannelListing([ok, bad]);
  assert.deepEqual(result, [
    { id: "gid://saleor/ProductVariant/3", sku: "SKU-3", missingChannels: ["default-channel", "us"] },
  ]);
});

test("order of missing channels follows product channels", () => {
  const result = findVariantsMissingChannelListing([
    variant({ productChannelSlugs: ["a", "b", "c"], variantChannelSlugs: ["b"] }),
  ]);
  assert.deepEqual(result[0].missingChannels, ["a", "c"]);
});

const PRODUCT_ID = "gid://saleor/Product/1";

const indexWithSiblingPrice = (amount = 19.99, slug = "us") => ({
  [PRODUCT_ID]: [
    { sku: "SKU-1", channelListingsRaw: [{ channel: { slug: "default-channel" }, price: { amount: 9.99 } }] },
    { sku: "SKU-2", channelListingsRaw: [{ channel: { slug }, price: { amount } }] },
  ],
});

test("findSiblingPrice returns matching channel price", () => {
  const index = indexWithSiblingPrice();
  assert.equal(findSiblingPrice(PRODUCT_ID, "us", index), 19.99);
});

test("findSiblingPrice returns null when no match", () => {
  const index = indexWithSiblingPrice(19.99, "eu");
  assert.equal(findSiblingPrice(PRODUCT_ID, "us", index), null);
});

test("findSiblingPrice ignores listings without price", () => {
  const index = { [PRODUCT_ID]: [{ sku: "SKU-1", channelListingsRaw: [{ channel: { slug: "us" }, price: null }] }] };
  assert.equal(findSiblingPrice(PRODUCT_ID, "us", index), null);
});

test("resolvePrice prefers sibling over default", () => {
  const index = indexWithSiblingPrice();
  assert.equal(resolvePrice(PRODUCT_ID, "us", index, { us: 5.0 }), 19.99);
});

test("resolvePrice falls back to default when no sibling", () => {
  const index = indexWithSiblingPrice(19.99, "eu");
  assert.equal(resolvePrice(PRODUCT_ID, "us", index, { us: 5.0 }), 5.0);
});

test("resolvePrice returns null when no sibling and no default", () => {
  const index = indexWithSiblingPrice(19.99, "eu");
  assert.equal(resolvePrice(PRODUCT_ID, "us", index, {}), null);
});
