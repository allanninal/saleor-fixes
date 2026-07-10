/**
 * Flag Saleor channels at risk of checkoutLinesAdd failing for anonymous carts.
 *
 * A channel is at risk when it has no defaultCountry and no warehouse with click and
 * collect enabled, or when its defaultCountry falls outside its own shipping zones with
 * no pickup fallback either way. In both cases Saleor cannot resolve a warehouse for a
 * cart that has no shipping address yet, and checkoutCreate or checkoutLinesAdd returns
 * a misleading INSUFFICIENT_STOCK style error even though a warehouse holds real stock.
 *
 * Reports by default. Only applies a repair (channelUpdate) when DRY_RUN=false is
 * explicitly set and FIX_DEFAULT_COUNTRY is provided, since the correct default country
 * or pickup warehouse is a business decision this script cannot infer safely.
 *
 * Guide: https://www.allanninal.dev/saleor/checkout-lines-add-fails-no-country/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://example.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const FIX_COUNTRY = process.env.FIX_DEFAULT_COUNTRY; // e.g. "US", only used if DRY_RUN is false

/**
 * Pure decision logic, no I/O.
 * @param {{defaultCountry: string|null, warehouses: {clickAndCollectOption: string}[], shippingZoneCountries: string[]}} channel
 * @returns {{atRisk: boolean, reason: string}}
 */
export function classifyCheckoutCountryRisk(channel) {
  const defaultCountry = channel.defaultCountry || null;
  const warehouses = channel.warehouses || [];
  const shippingZoneCountries = channel.shippingZoneCountries || [];

  const hasPickup = warehouses.some((w) => w.clickAndCollectOption !== "DISABLED");

  if (!defaultCountry && !hasPickup) {
    return { atRisk: true, reason: "no_default_country_no_pickup" };
  }

  if (defaultCountry && !shippingZoneCountries.includes(defaultCountry) && !hasPickup) {
    return { atRisk: true, reason: "default_country_outside_shipping_zone" };
  }

  return { atRisk: false, reason: "ok" };
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Saleor ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const CHANNELS_QUERY = `
query {
  channels {
    id
    slug
    defaultCountry { code }
    warehouses { id clickAndCollectOption }
  }
}`;

const CHANNEL_UPDATE = `
mutation($id: ID!, $defaultCountry: CountryCode!) {
  channelUpdate(id: $id, input: { defaultCountry: $defaultCountry }) {
    channel { id defaultCountry { code } }
    errors { field message }
  }
}`;

const CHECKOUT_CREATE = `
mutation($channel: String!, $variantId: ID!) {
  checkoutCreate(input: { channel: $channel, lines: [{ variantId: $variantId, quantity: 1 }] }) {
    checkout { id }
    errors { field code message }
  }
}`;

async function listChannels() {
  const channels = (await gql(CHANNELS_QUERY)).channels;
  for (const channel of channels) {
    channel.defaultCountry = channel.defaultCountry ? channel.defaultCountry.code : null;
  }
  return channels;
}

async function applyDefaultCountry(channelId, countryCode) {
  const result = (await gql(CHANNEL_UPDATE, { id: channelId, defaultCountry: countryCode })).channelUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.channel.defaultCountry.code;
}

/**
 * Confirm the bug live: an anonymous checkoutCreate with no shippingAddress against
 * a real in-stock variant returns a stock error even though stock > 0.
 */
async function reproduceFailure(channelSlug, variantId, stockQuantity) {
  const result = (await gql(CHECKOUT_CREATE, { channel: channelSlug, variantId })).checkoutCreate;
  const errors = result.errors || [];
  const stockError = errors.some((e) => (e.code || "").includes("STOCK"));
  return stockError && stockQuantity > 0;
}

export async function run() {
  const channels = await listChannels();
  let flagged = 0;
  for (const channel of channels) {
    const verdict = classifyCheckoutCountryRisk(channel);
    if (!verdict.atRisk) continue;
    flagged++;
    console.warn(
      `Channel ${channel.slug} at risk (${verdict.reason}). Suggested fix: set defaultCountry, or enable click and collect on a warehouse`
    );
    if (!DRY_RUN && FIX_COUNTRY) {
      const newCode = await applyDefaultCountry(channel.id, FIX_COUNTRY);
      console.log(`Channel ${channel.slug} defaultCountry set to ${newCode}`);
    }
  }
  console.log(`Done. ${flagged} channel(s) at risk.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
