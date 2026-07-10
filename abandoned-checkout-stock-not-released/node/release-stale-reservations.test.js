import { test } from "node:test";
import assert from "node:assert/strict";
import { findStaleReservedCheckouts } from "./release-stale-reservations.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const checkout = (over = {}) => ({
  id: "Q2hlY2tvdXQ6MQ==",
  lastChange: "2026-07-09T23:00:00Z",
  stockReservationExpires: null,
  lines: [{ id: "Q2hlY2tvdXRMaW5lOjE=", quantity: 1, variantSku: "SKU-1" }],
  ...over,
});

test("flags expired reservation", () => {
  const result = findStaleReservedCheckouts([checkout({ stockReservationExpires: "2026-07-09T23:55:00Z" })], NOW, 360);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "expired_reservation");
  assert.equal(result[0].id, "Q2hlY2tvdXQ6MQ==");
});

test("flags past ttl when no expiry set", () => {
  const result = findStaleReservedCheckouts([checkout({ lastChange: "2026-07-09T17:00:00Z" })], NOW, 360);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "past_ttl");
});

test("skips checkout within ttl and no expiry", () => {
  const result = findStaleReservedCheckouts([checkout({ lastChange: "2026-07-09T23:00:00Z" })], NOW, 360);
  assert.deepEqual(result, []);
});

test("skips checkout with future expiry", () => {
  const result = findStaleReservedCheckouts(
    [checkout({ stockReservationExpires: "2026-07-10T01:00:00Z", lastChange: "2026-07-09T23:50:00Z" })],
    NOW,
    360
  );
  assert.deepEqual(result, []);
});

test("returns line ids", () => {
  const lines = [{ id: "A" }, { id: "B" }];
  const result = findStaleReservedCheckouts(
    [checkout({ stockReservationExpires: "2026-07-09T20:00:00Z", lines })],
    NOW,
    360
  );
  assert.deepEqual(result[0].lineIds, ["A", "B"]);
});

test("skips checkout with no lastChange and no expiry", () => {
  const result = findStaleReservedCheckouts([checkout({ lastChange: null })], NOW, 360);
  assert.deepEqual(result, []);
});

test("exactly at expiry is stale", () => {
  const result = findStaleReservedCheckouts([checkout({ stockReservationExpires: "2026-07-10T00:00:00Z" })], NOW, 360);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "expired_reservation");
});

test("exactly at ttl is stale", () => {
  const result = findStaleReservedCheckouts([checkout({ lastChange: "2026-07-09T18:00:00Z" })], NOW, 360);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "past_ttl");
});
