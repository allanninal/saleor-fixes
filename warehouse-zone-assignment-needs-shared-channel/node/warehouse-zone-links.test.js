import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findOrphanedWarehouseZoneLinks,
  buildWarehouseChannelMap,
} from "./find-orphaned-warehouse-zone-links.js";

const WH_1 = { id: "V2FyZWhvdXNlOjE=", name: "Main warehouse" };
const WH_2 = { id: "V2FyZWhvdXNlOjI=", name: "Overflow warehouse" };

const zone = (over = {}) => ({
  id: "U2hpcHBpbmdab25lOjE=",
  name: "EU zone",
  channels: [{ id: "Q2hhbm5lbDox", slug: "default-channel" }],
  warehouses: [WH_1],
  ...over,
});

test("shared channel is not flagged", () => {
  const map = new Map([[WH_1.id, new Set(["default-channel"])]]);
  assert.deepEqual(findOrphanedWarehouseZoneLinks([zone()], map), []);
});

test("no shared channel is flagged", () => {
  const map = new Map([[WH_1.id, new Set(["other-channel"])]]);
  const result = findOrphanedWarehouseZoneLinks([zone()], map);
  assert.deepEqual(result, [{
    zoneId: "U2hpcHBpbmdab25lOjE=",
    zoneName: "EU zone",
    warehouseId: WH_1.id,
    warehouseName: "Main warehouse",
    zoneChannelSlugs: ["default-channel"],
  }]);
});

test("warehouse missing from map is flagged", () => {
  const result = findOrphanedWarehouseZoneLinks([zone()], new Map());
  assert.deepEqual(result, [{
    zoneId: "U2hpcHBpbmdab25lOjE=",
    zoneName: "EU zone",
    warehouseId: WH_1.id,
    warehouseName: "Main warehouse",
    zoneChannelSlugs: ["default-channel"],
  }]);
});

test("zone with no channels flags every warehouse", () => {
  const z = zone({ channels: [], warehouses: [WH_1, WH_2] });
  const map = new Map([
    [WH_1.id, new Set(["default-channel"])],
    [WH_2.id, new Set(["default-channel"])],
  ]);
  const result = findOrphanedWarehouseZoneLinks([z], map);
  assert.deepEqual(new Set(result.map((r) => r.warehouseId)), new Set([WH_1.id, WH_2.id]));
});

test("only the orphaned warehouse is flagged among several", () => {
  const z = zone({ warehouses: [WH_1, WH_2] });
  const map = new Map([
    [WH_1.id, new Set(["default-channel"])],
    [WH_2.id, new Set(["wholesale-channel"])],
  ]);
  const result = findOrphanedWarehouseZoneLinks([z], map);
  assert.deepEqual(result.map((r) => r.warehouseId), [WH_2.id]);
});

test("buildWarehouseChannelMap inverts channel warehouses", () => {
  const channels = [
    { slug: "default-channel", warehouses: { edges: [{ node: { id: WH_1.id } }] } },
    { slug: "wholesale-channel", warehouses: { edges: [
      { node: { id: WH_1.id } }, { node: { id: WH_2.id } },
    ] } },
  ];
  const result = buildWarehouseChannelMap(channels);
  assert.deepEqual(result, new Map([
    [WH_1.id, new Set(["default-channel", "wholesale-channel"])],
    [WH_2.id, new Set(["wholesale-channel"])],
  ]));
});
