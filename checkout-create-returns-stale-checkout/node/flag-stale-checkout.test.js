import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStaleCheckout } from "./flag-stale-checkout.js";

const HOUR_MS = 3600 * 1000;

const checkout = (over = {}) => ({
  id: "checkout-1",
  token: "tok-1",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-09T12:00:00Z",
  userEmail: "buyer@example.com",
  channelSlug: "default-channel",
  voucherCode: null,
  lines: [{ variantId: "v-1", isChannelListed: true }],
  expectedSessionId: null,
  storedSessionMeta: null,
  voucherIsActive: null,
  now: "2026-07-10T00:00:00Z",
  ...over,
});

test("not stale by default", () => {
  const result = classifyStaleCheckout(checkout(), 48 * HOUR_MS);
  assert.deepEqual(result, { stale: false, reasons: [] });
});

test("session mismatch flagged", () => {
  const result = classifyStaleCheckout(
    checkout({ expectedSessionId: "sess-new", storedSessionMeta: "sess-old" }),
    48 * HOUR_MS
  );
  assert.equal(result.stale, true);
  assert.ok(result.reasons.includes("session_mismatch"));
});

test("orphaned voucher flagged", () => {
  const result = classifyStaleCheckout(
    checkout({ voucherCode: "SUMMER10", voucherIsActive: false }),
    48 * HOUR_MS
  );
  assert.equal(result.stale, true);
  assert.ok(result.reasons.includes("orphaned_voucher"));
});

test("active voucher not flagged", () => {
  const result = classifyStaleCheckout(
    checkout({ voucherCode: "SUMMER10", voucherIsActive: true }),
    48 * HOUR_MS
  );
  assert.equal(result.stale, false);
});

test("delisted line flagged", () => {
  const result = classifyStaleCheckout(
    checkout({ lines: [{ variantId: "v-1", isChannelListed: false }] }),
    48 * HOUR_MS
  );
  assert.equal(result.stale, true);
  assert.ok(result.reasons.includes("delisted_line"));
});

test("long idle flagged", () => {
  const result = classifyStaleCheckout(checkout(), 6 * HOUR_MS);
  assert.equal(result.stale, true);
  assert.ok(result.reasons.includes("long_idle"));
});

test("multiple reasons all reported", () => {
  const result = classifyStaleCheckout(
    checkout({
      voucherCode: "OLD5",
      voucherIsActive: false,
      lines: [{ variantId: "v-2", isChannelListed: false }],
    }),
    6 * HOUR_MS
  );
  assert.equal(result.stale, true);
  assert.deepEqual(new Set(result.reasons), new Set(["orphaned_voucher", "delisted_line", "long_idle"]));
});
