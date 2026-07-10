import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVariantHealth } from "./flag-variantless-products.js";

const product = (over = {}) => ({
  id: "UHJvZHVjdDox",
  variants: [{ id: "UHJvZHVjdFZhcmlhbnQ6MQ==" }],
  channelListings: [{ channel: { slug: "default-channel" }, isPublished: true }],
  ...over,
});

test("OK when it has a variant", () => {
  assert.deepEqual(classifyVariantHealth(product()), { status: "OK", affectedChannels: [] });
});

test("NO_VARIANTS_PUBLISHED when a channel is published", () => {
  const result = classifyVariantHealth(product({ variants: [] }));
  assert.equal(result.status, "NO_VARIANTS_PUBLISHED");
  assert.deepEqual(result.affectedChannels, ["default-channel"]);
});

test("NO_VARIANTS_UNPUBLISHED when no channel is published", () => {
  const listings = [{ channel: { slug: "default-channel" }, isPublished: false }];
  const result = classifyVariantHealth(product({ variants: [], channelListings: listings }));
  assert.deepEqual(result, { status: "NO_VARIANTS_UNPUBLISHED", affectedChannels: [] });
});

test("multiple published channels are all reported", () => {
  const listings = [
    { channel: { slug: "default-channel" }, isPublished: true },
    { channel: { slug: "pos" }, isPublished: true },
    { channel: { slug: "b2b" }, isPublished: false },
  ];
  const result = classifyVariantHealth(product({ variants: [], channelListings: listings }));
  assert.equal(result.status, "NO_VARIANTS_PUBLISHED");
  assert.deepEqual(result.affectedChannels, ["default-channel", "pos"]);
});

test("no channel listings at all is unpublished", () => {
  const result = classifyVariantHealth(product({ variants: [], channelListings: [] }));
  assert.deepEqual(result, { status: "NO_VARIANTS_UNPUBLISHED", affectedChannels: [] });
});

test("missing variants key treated as empty", () => {
  const result = classifyVariantHealth({ id: "UHJvZHVjdDoy", channelListings: [] });
  assert.deepEqual(result, { status: "NO_VARIANTS_UNPUBLISHED", affectedChannels: [] });
});
