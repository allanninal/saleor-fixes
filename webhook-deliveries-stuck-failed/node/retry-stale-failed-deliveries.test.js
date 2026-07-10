import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStaleFailedRetries } from "./retry-stale-failed-deliveries.js";

const NOW = "2026-07-10T02:00:00Z"; // 2 hours after the attempts below

const attempt = (over = {}) => ({ createdAt: "2026-07-10T00:00:00Z", responseStatusCode: 503, ...over });

const delivery = (over = {}) => ({
  id: "gid://saleor/EventDelivery/1",
  status: "FAILED",
  createdAt: "2026-07-09T23:55:00Z",
  attempts: Array.from({ length: 5 }, () => attempt()),
  ...over,
});

test("skip when not failed", () => {
  const result = decideStaleFailedRetries([delivery({ status: "SUCCESS" })], NOW);
  assert.equal(result[0].action, "SKIP");
  assert.equal(result[0].reason, "not-failed");
});

test("skip when still within retry window", () => {
  const d = delivery({ attempts: [attempt({ createdAt: "2026-07-10T01:59:00Z" })] });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "SKIP");
  assert.equal(result[0].reason, "still-within-retry-window");
});

test("retry when stale and transient error", () => {
  // A 429 (rate limited) is not treated as a dead endpoint, unlike a 5xx.
  const d = delivery({ attempts: Array.from({ length: 5 }, () => attempt({ responseStatusCode: 429 })) });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "RETRY");
  assert.equal(result[0].reason, "stale-failed-past-retry-limit-transient-error");
});

test("retry when mixed status codes not all dead", () => {
  const attempts = [attempt({ responseStatusCode: 200 }), ...Array.from({ length: 4 }, () => attempt({ responseStatusCode: 503 }))];
  const d = delivery({ attempts });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "RETRY");
});

test("flag dead endpoint when all recent attempts are 5xx", () => {
  const d = delivery({ attempts: Array.from({ length: 5 }, () => attempt({ responseStatusCode: 500 })) });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "FLAG_DEAD_ENDPOINT");
  assert.equal(result[0].reason, "endpoint-repeatedly-unreachable");
});

test("flag dead endpoint when attempts have no response code", () => {
  const d = delivery({ attempts: Array.from({ length: 5 }, () => attempt({ responseStatusCode: null })) });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "FLAG_DEAD_ENDPOINT");
});

test("skip when recently exhausted but not yet stale", () => {
  const d = delivery({ attempts: Array.from({ length: 5 }, () => attempt({ createdAt: "2026-07-10T01:45:00Z" })) });
  const result = decideStaleFailedRetries([d], NOW, { staleAfterMs: 3600000 });
  assert.equal(result[0].action, "SKIP");
  assert.equal(result[0].reason, "recently-exhausted-wait-for-staleness-window");
});

test("skip when fewer than max retries and not stale", () => {
  const d = delivery({ attempts: [attempt({ createdAt: "2026-07-10T01:59:30Z" })] });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "SKIP");
  assert.equal(result[0].reason, "still-within-retry-window");
});

test("uses delivery createdAt when no attempts", () => {
  // No attempts means attemptCount (0) < maxRetries, so it has not exhausted
  // Saleor's retry budget yet, even though the delivery itself is old.
  const d = delivery({ attempts: [], createdAt: "2026-07-10T00:00:00Z" });
  const result = decideStaleFailedRetries([d], NOW);
  assert.equal(result[0].action, "SKIP");
  assert.equal(result[0].reason, "recently-exhausted-wait-for-staleness-window");
});

test("exactly at max retries and exactly stale boundary", () => {
  const d = delivery({ attempts: Array.from({ length: 5 }, () => attempt({ createdAt: "2026-07-10T01:00:00Z", responseStatusCode: 429 })) });
  const result = decideStaleFailedRetries([d], NOW, { staleAfterMs: 3600000 });
  assert.equal(result[0].action, "RETRY");
});
