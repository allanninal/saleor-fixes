import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGatewayGap } from "./find-gateway-gaps.js";

const CHANNEL_US = { slug: "us", currencyCode: "USD" };
const CHANNEL_EU = { slug: "eu", currencyCode: "EUR" };

const pluginConfig = (over = {}) => ({ channelSlug: "us", active: true, ...over });
const app = (over = {}) => ({
  appId: "QXBwOjE=",
  isActive: true,
  gateways: [{ id: "app.gateway", currencies: ["USD"] }],
  ...over,
});

test("available when plugin active for channel", () => {
  const result = decideGatewayGap(CHANNEL_US, [pluginConfig()], []);
  assert.deepEqual(result, { channelSlug: "us", hasAvailableGateway: true, reasons: [] });
});

test("flagged when plugin has no entry for channel", () => {
  const result = decideGatewayGap(CHANNEL_EU, [pluginConfig()], []);
  assert.equal(result.hasAvailableGateway, false);
  assert.ok(result.reasons.includes("plugin_inactive_for_channel"));
});

test("flagged when plugin entry inactive", () => {
  const result = decideGatewayGap(CHANNEL_US, [pluginConfig({ active: false })], []);
  assert.equal(result.hasAvailableGateway, false);
  assert.ok(result.reasons.includes("plugin_inactive_for_channel"));
});

test("available when active app matches currency", () => {
  const result = decideGatewayGap(CHANNEL_US, [], [app()]);
  assert.equal(result.hasAvailableGateway, true);
});

test("flagged when app disabled", () => {
  const result = decideGatewayGap(CHANNEL_US, [], [app({ isActive: false })]);
  assert.equal(result.hasAvailableGateway, false);
  assert.ok(result.reasons.includes("app_disabled"));
});

test("flagged when app currency mismatch", () => {
  const result = decideGatewayGap(CHANNEL_EU, [], [app()]);
  assert.equal(result.hasAvailableGateway, false);
  assert.ok(result.reasons.includes("currency_mismatch"));
});

test("available when either plugin or app covers channel", () => {
  const result = decideGatewayGap(CHANNEL_US, [pluginConfig({ active: false })], [app()]);
  assert.equal(result.hasAvailableGateway, true);
});

test("flagged with no plugin and no apps at all", () => {
  const result = decideGatewayGap(CHANNEL_US, [], []);
  assert.equal(result.hasAvailableGateway, false);
  assert.ok(result.reasons.includes("plugin_inactive_for_channel"));
});

test("flagged when multiple apps all disabled", () => {
  const result = decideGatewayGap(CHANNEL_US, [], [
    app({ isActive: false }),
    app({ isActive: false, appId: "QXBwOjI=" }),
  ]);
  assert.equal(result.hasAvailableGateway, false);
  assert.equal(result.reasons.filter((r) => r === "app_disabled").length, 2);
});
