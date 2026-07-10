import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphanedStock, toVariantStockRecords } from "./find-orphaned-stock.js";

const CHANNEL = { slug: "default-channel", warehouseIds: new Set(["V2FyZWhvdXNlOjE="]) };

const record = (over = {}) => ({
  variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
  warehouseId: "V2FyZWhvdXNlOjE=",
  quantity: 10,
  warehouseChannelSlugs: ["default-channel"],
  warehouseZones: [
    { id: "U2hpcHBpbmdab25lOjE=", channelSlugs: ["default-channel"], countries: ["US"] },
  ],
  ...over,
});

test("reachable stock is not flagged", () => {
  assert.deepEqual(findOrphanedStock([record()], CHANNEL, false), []);
});

test("zero quantity is ignored even if unlinked", () => {
  const r = record({ quantity: 0, warehouseChannelSlugs: [] });
  assert.deepEqual(findOrphanedStock([r], CHANNEL, false), []);
});

test("warehouse not linked to channel is flagged", () => {
  const r = record({ warehouseChannelSlugs: [] });
  const result = findOrphanedStock([r], CHANNEL, false);
  assert.deepEqual(result, [{
    variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
    warehouseId: "V2FyZWhvdXNlOjE=",
    reason: "warehouse not linked to channel",
  }]);
});

test("legacy mode off ignores zone gap", () => {
  const r = record({ warehouseZones: [] });
  assert.deepEqual(findOrphanedStock([r], CHANNEL, false), []);
});

test("legacy mode on flags missing zone channel link", () => {
  const r = record({ warehouseZones: [{ id: "Z1", channelSlugs: [], countries: ["US"] }] });
  const result = findOrphanedStock([r], CHANNEL, true);
  assert.deepEqual(result, [{
    variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
    warehouseId: "V2FyZWhvdXNlOjE=",
    reason: "warehouse zone not linked to channel/destination",
  }]);
});

test("legacy mode on and zone matches is not flagged", () => {
  assert.deepEqual(findOrphanedStock([record()], CHANNEL, true), []);
});

test("legacy mode on with destination country not covered is flagged", () => {
  const r = record({ warehouseZones: [{ id: "Z1", channelSlugs: ["default-channel"], countries: ["DE"] }] });
  const result = findOrphanedStock([r], CHANNEL, true, "US");
  assert.deepEqual(result, [{
    variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
    warehouseId: "V2FyZWhvdXNlOjE=",
    reason: "warehouse zone not linked to channel/destination",
  }]);
});

test("legacy mode on with destination country covered is not flagged", () => {
  assert.deepEqual(findOrphanedStock([record()], CHANNEL, true, "US"), []);
});

test("multiple zones only one matching is enough", () => {
  const r = record({
    warehouseZones: [
      { id: "Z1", channelSlugs: [], countries: ["US"] },
      { id: "Z2", channelSlugs: ["default-channel"], countries: ["US"] },
    ],
  });
  assert.deepEqual(findOrphanedStock([r], CHANNEL, true), []);
});

test("multiple records flags only the broken one", () => {
  const good = record();
  const bad = record({ variantId: "UHJvZHVjdFZhcmlhbnQ6Mg==", warehouseChannelSlugs: [] });
  const result = findOrphanedStock([good, bad], CHANNEL, false);
  assert.deepEqual(result, [{
    variantId: "UHJvZHVjdFZhcmlhbnQ6Mg==",
    warehouseId: "V2FyZWhvdXNlOjE=",
    reason: "warehouse not linked to channel",
  }]);
});

test("toVariantStockRecords flattens graphql shape", () => {
  const variantData = {
    stocks: [
      {
        quantity: 5,
        warehouse: {
          id: "V2FyZWhvdXNlOjE=",
          name: "Main warehouse",
          channels: [{ slug: "default-channel" }],
          shippingZones: {
            edges: [
              { node: { id: "Z1", channels: [{ slug: "default-channel" }], countries: [{ code: "US" }] } },
            ],
          },
        },
      },
    ],
  };
  const records = toVariantStockRecords("UHJvZHVjdFZhcmlhbnQ6MQ==", variantData);
  assert.deepEqual(records, [{
    variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
    warehouseId: "V2FyZWhvdXNlOjE=",
    quantity: 5,
    warehouseChannelSlugs: ["default-channel"],
    warehouseZones: [{ id: "Z1", channelSlugs: ["default-channel"], countries: ["US"] }],
  }]);
});
