import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMetadataWebhookGap } from "./detect-metadata-webhook-gap.js";

const WRITE_AT = "2026-07-10T12:00:00Z";

test("misconfigured when not subscribed to metadata event", () => {
  const result = classifyMetadataWebhookGap(WRITE_AT, [], new Set(["ORDER_UPDATED"]));
  assert.equal(result, "MISCONFIGURED_SUBSCRIPTION");
});

test("misconfigured even with unrelated deliveries", () => {
  const deliveries = [{ eventType: "ORDER_UPDATED", createdAt: "2026-07-10T13:00:00Z" }];
  const result = classifyMetadataWebhookGap(WRITE_AT, deliveries, new Set(["ORDER_UPDATED"]));
  assert.equal(result, "MISCONFIGURED_SUBSCRIPTION");
});

test("delivery missing when subscribed but no matching delivery", () => {
  const result = classifyMetadataWebhookGap(WRITE_AT, [], new Set(["ORDER_UPDATED", "ORDER_METADATA_UPDATED"]));
  assert.equal(result, "DELIVERY_MISSING");
});

test("delivery missing when only delivery is before the write", () => {
  const deliveries = [{ eventType: "ORDER_METADATA_UPDATED", createdAt: "2026-07-10T11:00:00Z" }];
  const result = classifyMetadataWebhookGap(WRITE_AT, deliveries, new Set(["ORDER_UPDATED", "ORDER_METADATA_UPDATED"]));
  assert.equal(result, "DELIVERY_MISSING");
});

test("ok when matching delivery exists after the write", () => {
  const deliveries = [{ eventType: "ORDER_METADATA_UPDATED", createdAt: "2026-07-10T12:00:01Z" }];
  const result = classifyMetadataWebhookGap(WRITE_AT, deliveries, new Set(["ORDER_UPDATED", "ORDER_METADATA_UPDATED"]));
  assert.equal(result, "OK");
});

test("ok when delivery is exactly at the write time", () => {
  const deliveries = [{ eventType: "ORDER_METADATA_UPDATED", createdAt: WRITE_AT }];
  const result = classifyMetadataWebhookGap(WRITE_AT, deliveries, new Set(["ORDER_UPDATED", "ORDER_METADATA_UPDATED"]));
  assert.equal(result, "OK");
});

test("ignores deliveries of other event types", () => {
  const deliveries = [{ eventType: "ORDER_UPDATED", createdAt: "2026-07-10T12:00:01Z" }];
  const result = classifyMetadataWebhookGap(WRITE_AT, deliveries, new Set(["ORDER_UPDATED", "ORDER_METADATA_UPDATED"]));
  assert.equal(result, "DELIVERY_MISSING");
});
