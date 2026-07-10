import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findChannelsMissingShippingCoverage,
  findUnambiguousRepair,
} from "./find-missing-shipping-coverage.js";

const CH_A = { id: "Q2hhbm5lbDox" };
const CH_B = { id: "Q2hhbm5lbDoy" };

const zone = (over = {}) => ({
  id: "U2hpcHBpbmdab25lOjE=",
  channels: [{ id: "Q2hhbm5lbDox" }],
  warehouses: [{ id: "V2FyZWhvdXNlOjE=", channels: [{ id: "Q2hhbm5lbDox" }] }],
  shippingMethods: [
    { id: "U2hpcHBpbmdNZXRob2Q6MQ==", name: "Standard", channelListings: [{ channel: { id: "Q2hhbm5lbDox" } }] },
  ],
  ...over,
});

test("channel fully covered is not flagged", () => {
  assert.deepEqual(findChannelsMissingShippingCoverage([CH_A], [zone()]), []);
});

test("channel with no zone is flagged", () => {
  const result = findChannelsMissingShippingCoverage([CH_B], [zone()]);
  assert.deepEqual(result, [{ channelId: "Q2hhbm5lbDoy", reason: "NO_ZONE" }]);
});

test("channel with zone but no warehouse is flagged", () => {
  const z = zone({ warehouses: [{ id: "V2FyZWhvdXNlOjE=", channels: [] }] });
  const result = findChannelsMissingShippingCoverage([CH_A], [z]);
  assert.deepEqual(result, [{ channelId: "Q2hhbm5lbDox", reason: "NO_WAREHOUSE_IN_CHANNEL" }]);
});

test("channel with zone and warehouse but no listed method is flagged", () => {
  const z = zone({ shippingMethods: [{ id: "U2hpcHBpbmdNZXRob2Q6MQ==", name: "Standard", channelListings: [] }] });
  const result = findChannelsMissingShippingCoverage([CH_A], [z]);
  assert.deepEqual(result, [{ channelId: "Q2hhbm5lbDox", reason: "NO_METHOD_LISTED" }]);
});

test("multiple channels only flags the broken one", () => {
  const result = findChannelsMissingShippingCoverage([CH_A, CH_B], [zone()]);
  assert.deepEqual(result, [{ channelId: "Q2hhbm5lbDoy", reason: "NO_ZONE" }]);
});

test("zone with no channels at all flags every channel", () => {
  const z = zone({ channels: [] });
  const result = findChannelsMissingShippingCoverage([CH_A, CH_B], [z]);
  assert.deepEqual(result, [
    { channelId: "Q2hhbm5lbDox", reason: "NO_ZONE" },
    { channelId: "Q2hhbm5lbDoy", reason: "NO_ZONE" },
  ]);
});

test("no shipping zones at all still flags NO_ZONE", () => {
  const result = findChannelsMissingShippingCoverage([CH_B], []);
  assert.deepEqual(result, [{ channelId: "Q2hhbm5lbDoy", reason: "NO_ZONE" }]);
});

test("unambiguous repair found when zone scoped to one channel", () => {
  const z = zone({ shippingMethods: [{ id: "U2hpcHBpbmdNZXRob2Q6MQ==", name: "Standard", channelListings: [] }] });
  const repair = findUnambiguousRepair(CH_A, [z]);
  assert.deepEqual(repair, { shippingMethodId: "U2hpcHBpbmdNZXRob2Q6MQ==", shippingMethodName: "Standard" });
});

test("no repair when zone shared by multiple channels", () => {
  const z = zone({
    channels: [{ id: "Q2hhbm5lbDox" }, { id: "Q2hhbm5lbDoy" }],
    shippingMethods: [{ id: "U2hpcHBpbmdNZXRob2Q6MQ==", name: "Standard", channelListings: [] }],
  });
  assert.equal(findUnambiguousRepair(CH_A, [z]), null);
});

test("no repair when method already listed", () => {
  assert.equal(findUnambiguousRepair(CH_A, [zone()]), null);
});
