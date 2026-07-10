import { test } from "node:test";
import assert from "node:assert/strict";
import { planInvalidIndexRepair } from "./repair-invalid-index.js";

const row = (over = {}) => ({
  schema_name: "public",
  index_name: "product_product_name_idx",
  table_name: "product_product",
  indisvalid: false,
  indisready: true,
  ...over,
});

test("empty input returns empty plan", () => {
  assert.deepEqual(planInvalidIndexRepair([], true), []);
});

test("valid index is excluded", () => {
  const plan = planInvalidIndexRepair([row({ indisvalid: true })], true);
  assert.deepEqual(plan, []);
});

test("invalid and not ready still plans drop_concurrently", () => {
  const plan = planInvalidIndexRepair([row({ indisready: false })], false);
  assert.equal(plan[0].action, "drop_concurrently");
  assert.equal(plan[0].indisready, false);
});

test("invalid and ready still plans drop_concurrently", () => {
  const plan = planInvalidIndexRepair([row({ indisready: true })], false);
  assert.equal(plan[0].action, "drop_concurrently");
  assert.equal(plan[0].indisready, true);
});

test("dry run true never emits anything but log_only", () => {
  const plan = planInvalidIndexRepair([row({ indisready: false }), row({ indisready: true })], true);
  assert.ok(plan.every((item) => item.action === "log_only"));
});

test("deduplicates by schema and index name", () => {
  const plan = planInvalidIndexRepair([row(), row()], true);
  assert.equal(plan.length, 1);
});

test("different index names are not deduplicated", () => {
  const plan = planInvalidIndexRepair([row({ index_name: "a_idx" }), row({ index_name: "b_idx" })], true);
  assert.equal(plan.length, 2);
});

test("sql uses drop index concurrently if exists", () => {
  const plan = planInvalidIndexRepair([row()], true);
  assert.equal(plan[0].sql, 'DROP INDEX CONCURRENTLY IF EXISTS "public"."product_product_name_idx";');
});

test("requires_migration_replay is always true", () => {
  const plan = planInvalidIndexRepair([row()], true);
  assert.equal(plan[0].requires_migration_replay, true);
});

test("table_name is carried through", () => {
  const plan = planInvalidIndexRepair([row({ table_name: "order_order" })], true);
  assert.equal(plan[0].table_name, "order_order");
});
