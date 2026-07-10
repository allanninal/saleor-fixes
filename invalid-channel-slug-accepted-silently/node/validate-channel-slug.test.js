import { test } from "node:test";
import assert from "node:assert/strict";
import { decideChannelSlugValidity, requireValidChannel, InvalidChannelSlugError } from "./validate-channel-slug.js";

const CHANNELS = [
  { slug: "default-channel", isActive: true },
  { slug: "us-store", isActive: true },
  { slug: "eu-store", isActive: false },
];

test("exact match is valid", () => {
  assert.deepEqual(decideChannelSlugValidity("us-store", CHANNELS), { status: "VALID", suggestion: null });
});

test("exact match on inactive channel is inactive", () => {
  assert.deepEqual(decideChannelSlugValidity("eu-store", CHANNELS), { status: "INACTIVE", suggestion: null });
});

test("typo is unknown with close suggestion", () => {
  const result = decideChannelSlugValidity("us-stor", CHANNELS);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.suggestion, "us-store");
});

test("completely unrelated slug has no suggestion", () => {
  const result = decideChannelSlugValidity("zzz-totally-different", CHANNELS);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.suggestion, null);
});

test("empty known channels is unknown with no suggestion", () => {
  assert.deepEqual(decideChannelSlugValidity("us-store", []), { status: "UNKNOWN", suggestion: null });
});

test("short prefix match can still suggest", () => {
  const result = decideChannelSlugValidity("us", CHANNELS);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.suggestion, "us-store");
});

test("requireValidChannel throws with suggestion", () => {
  assert.throws(
    () => requireValidChannel("us-stor", CHANNELS, "products(channel=...)"),
    (err) => err instanceof InvalidChannelSlugError && err.message.includes("us-stor") && err.message.includes("us-store")
  );
});

test("requireValidChannel does not throw for valid slug", () => {
  const decision = requireValidChannel("default-channel", CHANNELS);
  assert.equal(decision.status, "VALID");
});

test("requireValidChannel does not throw for inactive slug", () => {
  const decision = requireValidChannel("eu-store", CHANNELS);
  assert.equal(decision.status, "INACTIVE");
});
