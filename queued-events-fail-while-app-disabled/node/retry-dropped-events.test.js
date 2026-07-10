import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDroppedDeliveries } from "./retry-dropped-events.js";

const DISABLED_AT = "2026-06-25T09:00:00Z";
const REENABLED_AT = "2026-06-25T11:30:00Z";
const NOW = "2026-06-30T09:00:00Z";

const delivery = (over = {}) => ({
  id: "gid://saleor/EventDelivery/1",
  createdAt: "2026-06-25T10:00:00Z",
  status: "FAILED",
  eventType: "ORDER_CREATED",
  payload: '{"id": "gid://saleor/Order/1"}',
  ...over,
});

test("before window is skipped", () => {
  const d = delivery({ createdAt: "2026-06-25T08:00:00Z" });
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "SKIP" }]);
});

test("inside window with payload is retried", () => {
  const d = delivery();
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "RETRY" }]);
});

test("inside window past retention is unrecoverable", () => {
  const oldNow = "2026-07-15T09:00:00Z"; // more than 14 days after createdAt
  const d = delivery();
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, oldNow);
  assert.deepEqual(result, [{ id: d.id, action: "FLAG_UNRECOVERABLE" }]);
});

test("inside window null payload is unrecoverable", () => {
  const d = delivery({ payload: null });
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "FLAG_UNRECOVERABLE" }]);
});

test("success status inside window is skipped", () => {
  const d = delivery({ status: "SUCCESS" });
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "SKIP" }]);
});

test("pending status inside window is skipped", () => {
  const d = delivery({ status: "PENDING" });
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "SKIP" }]);
});

test("after window is skipped", () => {
  const d = delivery({ createdAt: "2026-06-25T12:00:00Z" });
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "SKIP" }]);
});

test("no reenabledAt uses now as window end", () => {
  const d = delivery({ createdAt: "2026-06-29T09:00:00Z" });
  const result = classifyDroppedDeliveries([d], DISABLED_AT, null, NOW);
  assert.deepEqual(result, [{ id: d.id, action: "RETRY" }]);
});

test("exactly at retention boundary is retried", () => {
  const d = delivery({ createdAt: "2026-06-25T10:00:00Z" });
  const nowAtBoundary = "2026-07-09T10:00:00Z";
  const result = classifyDroppedDeliveries([d], DISABLED_AT, REENABLED_AT, nowAtBoundary);
  assert.deepEqual(result, [{ id: d.id, action: "RETRY" }]);
});

test("multiple deliveries mixed actions", () => {
  const deliveries = [
    delivery({ id: "a", createdAt: "2026-06-25T08:00:00Z" }),
    delivery({ id: "b" }),
    delivery({ id: "c", payload: null }),
    delivery({ id: "d", status: "SUCCESS" }),
  ];
  const result = classifyDroppedDeliveries(deliveries, DISABLED_AT, REENABLED_AT, NOW);
  assert.deepEqual(result, [
    { id: "a", action: "SKIP" },
    { id: "b", action: "RETRY" },
    { id: "c", action: "FLAG_UNRECOVERABLE" },
    { id: "d", action: "SKIP" },
  ]);
});
