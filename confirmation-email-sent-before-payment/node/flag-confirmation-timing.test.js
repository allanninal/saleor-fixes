import { test } from "node:test";
import assert from "node:assert/strict";
import { decideConfirmationTimingIssue } from "./flag-confirmation-timing.js";

const NOW = new Date("2026-07-10T00:00:00Z").getTime();
const hoursAgo = (h) => NOW - h * 60 * 60 * 1000;

test("ok when no confirmation was ever sent", () => {
  const result = decideConfirmationTimingIssue(null, hoursAgo(1), false, NOW);
  assert.equal(result, "ok");
});

test("ok when charge succeeded before confirmation", () => {
  const confirm = hoursAgo(1);
  const charge = hoursAgo(2);
  assert.equal(decideConfirmationTimingIssue(confirm, charge, false, NOW), "ok");
});

test("ok when charge succeeded after confirmation in the same request", () => {
  const confirm = hoursAgo(2);
  const charge = hoursAgo(1);
  assert.equal(decideConfirmationTimingIssue(confirm, charge, false, NOW), "ok");
});

test("ok when confirm equals charge timestamp", () => {
  const ts = hoursAgo(3);
  assert.equal(decideConfirmationTimingIssue(ts, ts, false, NOW), "ok");
});

test("ok when no charge but order is paid another way", () => {
  assert.equal(decideConfirmationTimingIssue(hoursAgo(30), null, true, NOW), "ok");
});

test("flag_email_premature when recent and unpaid with no charge", () => {
  const result = decideConfirmationTimingIssue(hoursAgo(1), null, false, NOW, 24);
  assert.equal(result, "flag_email_premature");
});

test("flag_and_eligible_for_cancel past the grace window", () => {
  const result = decideConfirmationTimingIssue(hoursAgo(25), null, false, NOW, 24);
  assert.equal(result, "flag_and_eligible_for_cancel");
});

test("exactly at the grace window is eligible for cancel", () => {
  const result = decideConfirmationTimingIssue(hoursAgo(24), null, false, NOW, 24);
  assert.equal(result, "flag_and_eligible_for_cancel");
});

test("a custom grace window is respected", () => {
  const result = decideConfirmationTimingIssue(hoursAgo(5), null, false, NOW, 4);
  assert.equal(result, "flag_and_eligible_for_cancel");
});

test("just under the grace window is still premature", () => {
  const result = decideConfirmationTimingIssue(hoursAgo(23), null, false, NOW, 24);
  assert.equal(result, "flag_email_premature");
});
