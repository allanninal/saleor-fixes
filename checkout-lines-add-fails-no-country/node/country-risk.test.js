import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCheckoutCountryRisk } from "./flag-checkout-country-risk.js";

const channel = (over = {}) => ({
  defaultCountry: "US",
  warehouses: [{ clickAndCollectOption: "DISABLED" }],
  shippingZoneCountries: ["US", "CA"],
  ...over,
});

test("ok when default country set and no pickup needed", () => {
  const result = classifyCheckoutCountryRisk(channel());
  assert.equal(result.atRisk, false);
  assert.equal(result.reason, "ok");
});

test("at risk when no default country and no pickup", () => {
  const result = classifyCheckoutCountryRisk(channel({ defaultCountry: null }));
  assert.equal(result.atRisk, true);
  assert.equal(result.reason, "no_default_country_no_pickup");
});

test("ok when no default country but pickup enabled", () => {
  const result = classifyCheckoutCountryRisk(
    channel({ defaultCountry: null, warehouses: [{ clickAndCollectOption: "ALL_WAREHOUSES" }] })
  );
  assert.equal(result.atRisk, false);
  assert.equal(result.reason, "ok");
});

test("at risk when default country outside shipping zone", () => {
  const result = classifyCheckoutCountryRisk(channel({ defaultCountry: "FR" }));
  assert.equal(result.atRisk, true);
  assert.equal(result.reason, "default_country_outside_shipping_zone");
});

test("ok when default country outside zone but pickup enabled", () => {
  const result = classifyCheckoutCountryRisk(
    channel({ defaultCountry: "FR", warehouses: [{ clickAndCollectOption: "LOCAL_STOCK" }] })
  );
  assert.equal(result.atRisk, false);
});

test("at risk when no warehouses at all", () => {
  const result = classifyCheckoutCountryRisk(channel({ defaultCountry: null, warehouses: [] }));
  assert.equal(result.atRisk, true);
  assert.equal(result.reason, "no_default_country_no_pickup");
});

test("ok when multiple warehouses and one has pickup", () => {
  const result = classifyCheckoutCountryRisk(
    channel({
      defaultCountry: null,
      warehouses: [
        { clickAndCollectOption: "DISABLED" },
        { clickAndCollectOption: "LOCAL_STOCK" },
      ],
    })
  );
  assert.equal(result.atRisk, false);
});
