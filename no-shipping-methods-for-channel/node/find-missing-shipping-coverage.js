/**
 * Flag Saleor channels that have no usable shipping methods, and why.
 *
 * A ShippingMethod is only usable at checkout for a channel when the zone covers
 * the channel, a warehouse in that zone is assigned to the channel, and the method
 * has its own ShippingMethodChannelListing for that channel. This queries channels
 * and shipping zones, classifies each channel as NO_ZONE, NO_WAREHOUSE_IN_CHANNEL,
 * NO_METHOD_LISTED, or not flagged, and reports it. It never writes blindly: a repair
 * mutation is only ever printed under DRY_RUN, and only for the unambiguous case of a
 * method whose zone is already fully scoped to one channel and is only missing the
 * per-channel listing.
 *
 * Guide: https://www.allanninal.dev/saleor/no-shipping-methods-for-channel/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CHANNELS_QUERY = `
query { channels { id name slug currencyCode } }`;

const ZONES_QUERY = `
query {
  shippingZones(first: 100) {
    edges {
      node {
        id name
        channels { id }
        warehouses { id channels { id } }
        shippingMethods { id name channelListings { channel { id } price { amount } } }
      }
    }
  }
}`;

const SHIPPING_METHOD_CHANNEL_LISTING_UPDATE = `
mutation($id: ID!, $input: ShippingMethodChannelListingInput!) {
  shippingMethodChannelListingUpdate(id: $id, input: $input) {
    shippingMethod { id }
    errors { field message }
  }
}`;

/**
 * Pure decision function. Takes plain data structures already fetched and
 * returns a list of {channelId, reason} for every channel that has no usable
 * shipping method. Does no I/O, deterministic, easy to unit test.
 */
export function findChannelsMissingShippingCoverage(channels, shippingZones) {
  const flagged = [];
  for (const channel of channels) {
    const cid = channel.id;
    const zonesForChannel = shippingZones.filter((z) =>
      (z.channels || []).some((c) => c.id === cid)
    );
    if (zonesForChannel.length === 0) {
      flagged.push({ channelId: cid, reason: "NO_ZONE" });
      continue;
    }

    const hasWarehouse = zonesForChannel.some((z) =>
      (z.warehouses || []).some((wh) => (wh.channels || []).some((c) => c.id === cid))
    );
    if (!hasWarehouse) {
      flagged.push({ channelId: cid, reason: "NO_WAREHOUSE_IN_CHANNEL" });
      continue;
    }

    const hasListedMethod = zonesForChannel.some((z) =>
      (z.shippingMethods || []).some((m) =>
        (m.channelListings || []).some((cl) => cl.channel.id === cid)
      )
    );
    if (!hasListedMethod) {
      flagged.push({ channelId: cid, reason: "NO_METHOD_LISTED" });
    }
  }
  return flagged;
}

/**
 * A repair is unambiguous only when exactly one zone covers the channel,
 * that zone has no other channels, and it has at least one shipping method
 * with no listing for this channel yet.
 */
export function findUnambiguousRepair(channel, shippingZones) {
  const cid = channel.id;
  const zonesForChannel = shippingZones.filter((z) =>
    (z.channels || []).some((c) => c.id === cid)
  );
  if (zonesForChannel.length !== 1) return null;
  const zone = zonesForChannel[0];
  if ((zone.channels || []).length !== 1) return null;
  for (const method of zone.shippingMethods || []) {
    const hasListing = (method.channelListings || []).some((cl) => cl.channel.id === cid);
    if (!hasListing) {
      return { shippingMethodId: method.id, shippingMethodName: method.name };
    }
  }
  return null;
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Saleor ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function fetchChannelsAndZones() {
  const channels = (await gql(CHANNELS_QUERY)).channels;
  const zones = (await gql(ZONES_QUERY)).shippingZones.edges.map((e) => e.node);
  return { channels, zones };
}

function printPlannedListingUpdate(shippingMethodId, channelId, currency) {
  const variables = {
    id: shippingMethodId,
    input: { addChannels: [{ channelId, price: "0.00", currency }] },
  };
  console.log("DRY RUN would call shippingMethodChannelListingUpdate:", JSON.stringify(variables));
}

export async function run() {
  const { channels, zones } = await fetchChannelsAndZones();
  const flagged = findChannelsMissingShippingCoverage(channels, zones);
  const byId = Object.fromEntries(channels.map((c) => [c.id, c]));

  if (flagged.length === 0) {
    console.log("Every channel has at least one usable shipping method.");
    return;
  }

  for (const item of flagged) {
    const channel = byId[item.channelId];
    console.warn(`Channel ${channel.name} (${channel.slug}) has no usable shipping methods: ${item.reason}`);
    if (item.reason === "NO_METHOD_LISTED") {
      const repair = findUnambiguousRepair(channel, zones);
      if (repair) {
        console.log(`Unambiguous repair candidate: method ${repair.shippingMethodName} is missing a listing.`);
        if (DRY_RUN) {
          printPlannedListingUpdate(repair.shippingMethodId, channel.id, channel.currencyCode);
        } else {
          console.warn("DRY_RUN is false, but this script only prints planned repairs. "
            + "Review the printed mutation and apply it by hand or from your own reviewed tooling.");
        }
      }
    }
  }

  console.log(`Done. ${flagged.length} channel(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
