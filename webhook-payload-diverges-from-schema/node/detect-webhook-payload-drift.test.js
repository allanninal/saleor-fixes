import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPayloadAgainstSchema, extractSelectionFields } from "./detect-webhook-payload-drift.js";

test("no drift when payload matches expected fields", () => {
  const payload = { id: "gid://saleor/Product/1", name: "Mug", slug: "mug" };
  const result = diffPayloadAgainstSchema(payload, ["id", "name", "slug"]);
  assert.deepEqual(result, { missingInPayload: [], unexpectedInPayload: [] });
});

test("detects renamed field as missing", () => {
  const payload = { id: "1", name: "Mug", categoryId: "9" };
  const result = diffPayloadAgainstSchema(payload, ["id", "name", "category"]);
  assert.deepEqual(result.missingInPayload, ["category"]);
  assert.deepEqual(result.unexpectedInPayload, ["categoryId"]);
});

test("detects deprecated field returning null", () => {
  const payload = { id: "1", name: "Mug", chargeTaxes: null };
  const result = diffPayloadAgainstSchema(payload, ["id", "name", "chargeTaxes"]);
  assert.deepEqual(result.missingInPayload, ["chargeTaxes"]);
  assert.deepEqual(result.unexpectedInPayload, []);
});

test("detects extra field from newer Saleor version", () => {
  const payload = { id: "1", name: "Mug", slug: "mug", externalReference: "ext-1" };
  const result = diffPayloadAgainstSchema(payload, ["id", "name", "slug"]);
  assert.deepEqual(result.missingInPayload, []);
  assert.deepEqual(result.unexpectedInPayload, ["externalReference"]);
});

test("non-object payload flags all fields missing", () => {
  const result = diffPayloadAgainstSchema(null, ["id", "name"]);
  assert.deepEqual(result, { missingInPayload: ["id", "name"], unexpectedInPayload: [] });
});

test("nested path is used in labels", () => {
  const payload = { id: "1" };
  const result = diffPayloadAgainstSchema(payload, ["id", "name"], { path: "product" });
  assert.deepEqual(result.missingInPayload, ["product.name"]);
  assert.deepEqual(result.unexpectedInPayload, []);
});

test("extractSelectionFields reads top level only", () => {
  const fragment = "on ProductUpdated { product { id name category { id } } }";
  assert.deepEqual(extractSelectionFields(fragment), ["product"]);
});
