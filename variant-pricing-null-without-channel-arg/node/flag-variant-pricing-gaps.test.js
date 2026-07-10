import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVariantPricing } from "./flag-variant-pricing-gaps.js";

const ACTIVE = ["default-channel", "eu-channel"];

const variant = (over = {}) => ({
  id: "gid://saleor/ProductVariant/1",
  sku: "SKU-1",
  channelListings: [
    { channelSlug: "default-channel", isPublished: true, price: { amount: 19.99, currency: "USD" } },
  ],
  ...over,
});

test("priced when active listing has price", () => {
  assert.equal(classifyVariantPricing(variant(), ACTIVE), "PRICED");
});

test("unpriced null price when listing price is null", () => {
  const v = variant({ channelListings: [{ channelSlug: "default-channel", isPublished: true, price: null }] });
  assert.equal(classifyVariantPricing(v, ACTIVE), "UNPRICED_NULL_PRICE");
});

test("not sold in active channel when no relevant listing", () => {
  const v = variant({ channelListings: [{ channelSlug: "inactive-channel", isPublished: true, price: { amount: 5, currency: "USD" } }] });
  assert.equal(classifyVariantPricing(v, ACTIVE), "NOT_SOLD_IN_ACTIVE_CHANNEL");
});

test("not sold in active channel when no listings at all", () => {
  const v = variant({ channelListings: [] });
  assert.equal(classifyVariantPricing(v, ACTIVE), "NOT_SOLD_IN_ACTIVE_CHANNEL");
});

test("priced when multiple active channels all priced", () => {
  const v = variant({
    channelListings: [
      { channelSlug: "default-channel", isPublished: true, price: { amount: 19.99, currency: "USD" } },
      { channelSlug: "eu-channel", isPublished: true, price: { amount: 18.5, currency: "EUR" } },
    ],
  });
  assert.equal(classifyVariantPricing(v, ACTIVE), "PRICED");
});

test("unpriced null price wins over priced channel", () => {
  const v = variant({
    channelListings: [
      { channelSlug: "default-channel", isPublished: true, price: { amount: 19.99, currency: "USD" } },
      { channelSlug: "eu-channel", isPublished: true, price: null },
    ],
  });
  assert.equal(classifyVariantPricing(v, ACTIVE), "UNPRICED_NULL_PRICE");
});

test("channel not in active list is ignored", () => {
  const v = variant({
    channelListings: [
      { channelSlug: "default-channel", isPublished: true, price: { amount: 19.99, currency: "USD" } },
      { channelSlug: "retired-channel", isPublished: true, price: null },
    ],
  });
  assert.equal(classifyVariantPricing(v, ACTIVE), "PRICED");
});
