import { test } from "node:test";
import assert from "node:assert/strict";
import { findMispricedPublishedListings } from "./find-mispriced-published-listings.js";

const product = (over = {}) => ({
  id: "UHJvZHVjdDox",
  channelListings: [{ channelSlug: "default-channel", isPublished: true }],
  variants: [
    {
      id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      channelListings: [{ channelSlug: "default-channel", priceAmount: 19.99 }],
    },
  ],
  ...over,
});

test("fully priced published product is not flagged", () => {
  assert.deepEqual(findMispricedPublishedListings([product()]), []);
});

test("published variant with no channel listing is flagged missing_price", () => {
  const p = product({ variants: [{ id: "UHJvZHVjdFZhcmlhbnQ6MQ==", channelListings: [] }] });
  const result = findMispricedPublishedListings([p]);
  assert.deepEqual(result, [{
    productId: "UHJvZHVjdDox",
    variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
    channelSlug: "default-channel",
    reason: "missing_price",
  }]);
});

test("published variant with null price is flagged missing_price", () => {
  const p = product({
    variants: [{
      id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      channelListings: [{ channelSlug: "default-channel", priceAmount: null }],
    }],
  });
  const result = findMispricedPublishedListings([p]);
  assert.equal(result[0].reason, "missing_price");
});

test("published variant with zero price is flagged zero_price", () => {
  const p = product({
    variants: [{
      id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      channelListings: [{ channelSlug: "default-channel", priceAmount: 0 }],
    }],
  });
  const result = findMispricedPublishedListings([p]);
  assert.equal(result[0].reason, "zero_price");
});

test("negative price is flagged zero_price", () => {
  const p = product({
    variants: [{
      id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      channelListings: [{ channelSlug: "default-channel", priceAmount: -5 }],
    }],
  });
  const result = findMispricedPublishedListings([p]);
  assert.equal(result[0].reason, "zero_price");
});

test("unpublished listing is never flagged", () => {
  const p = product({ channelListings: [{ channelSlug: "default-channel", isPublished: false }] });
  assert.deepEqual(findMispricedPublishedListings([p]), []);
});

test("only the matching channel slug is checked", () => {
  const p = product({
    channelListings: [{ channelSlug: "default-channel", isPublished: true }],
    variants: [{
      id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      channelListings: [{ channelSlug: "other-channel", priceAmount: 9.99 }],
    }],
  });
  const result = findMispricedPublishedListings([p]);
  assert.equal(result[0].reason, "missing_price");
});

test("multiple channels only flags the unpriced one", () => {
  const p = product({
    channelListings: [
      { channelSlug: "default-channel", isPublished: true },
      { channelSlug: "eu-channel", isPublished: true },
    ],
    variants: [{
      id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      channelListings: [
        { channelSlug: "default-channel", priceAmount: 19.99 },
        { channelSlug: "eu-channel", priceAmount: null },
      ],
    }],
  });
  const result = findMispricedPublishedListings([p]);
  assert.deepEqual(result, [{
    productId: "UHJvZHVjdDox",
    variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
    channelSlug: "eu-channel",
    reason: "missing_price",
  }]);
});

test("no products returns empty list", () => {
  assert.deepEqual(findMispricedPublishedListings([]), []);
});
