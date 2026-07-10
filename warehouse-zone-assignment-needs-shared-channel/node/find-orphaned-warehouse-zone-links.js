/**
 * Find Saleor shipping zones whose warehouses share no channel with the zone.
 *
 * A ShippingZone can only use a warehouse for fulfillment when that warehouse shares
 * at least one channel with the zone. shippingZoneUpdate(addWarehouses: ...) enforces
 * this at write time and rejects the field with INVALID if the shared channel is
 * missing (see saleor/saleor issue #17029). But nothing revalidates the link later:
 * if a channel is removed from the warehouse or from the zone afterward, the warehouse
 * stays listed on the zone with zero shared channels, and its stock silently drops out
 * of that zone's fulfillment. This queries every shipping zone with its channels and
 * warehouses, and every channel with its warehouses, builds a warehouse-to-channels
 * map, and reports every zone-warehouse pair whose channel intersection is empty.
 * It never writes by default. An optional --repair flag detaches the orphaned pair
 * with shippingZoneUpdate(removeWarehouses: ...); attaching a new shared channel is
 * left to a human, since that depends on merchant intent.
 *
 * Guide: https://www.allanninal.dev/saleor/warehouse-zone-assignment-needs-shared-channel/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ZONES_AND_CHANNELS_QUERY = `
query {
  shippingZones(first: 100) {
    edges {
      node {
        id name
        channels { id slug }
        warehouses { id name }
      }
    }
  }
  channels(first: 100) {
    edges {
      node {
        id slug
        warehouses(first: 100) { edges { node { id } } }
      }
    }
  }
}`;

const REMOVE_WAREHOUSES_MUTATION = `
mutation($id: ID!, $warehouseIds: [ID!]!) {
  shippingZoneUpdate(id: $id, input: { removeWarehouses: $warehouseIds }) {
    shippingZone { id }
    shippingErrors { field message }
  }
}`;

/**
 * Invert Channel.warehouses into a Map of warehouseId -> Set(channelSlug).
 *
 * Warehouse has no direct channels field in the Saleor schema, so this reverse
 * relation from the channels query is the only way to learn which channels a
 * warehouse actually belongs to.
 */
export function buildWarehouseChannelMap(channels) {
  const warehouseChannelMap = new Map();
  for (const channel of channels) {
    const slug = channel.slug;
    for (const edge of channel.warehouses?.edges || []) {
      const wid = edge.node.id;
      if (!warehouseChannelMap.has(wid)) warehouseChannelMap.set(wid, new Set());
      warehouseChannelMap.get(wid).add(slug);
    }
  }
  return warehouseChannelMap;
}

/**
 * Pure decision function. No I/O.
 *
 * For each shipping zone, compute its channel slugs. For each warehouse assigned
 * to that zone, look up the warehouse's channel slugs from the precomputed map
 * (defaulting to an empty set when the warehouse is missing from the map). If the
 * intersection of the two sets is empty, the warehouse cannot actually fulfill
 * that zone, so the pair is orphaned and gets reported.
 */
export function findOrphanedWarehouseZoneLinks(shippingZones, warehouseChannelMap) {
  const orphaned = [];
  for (const zone of shippingZones) {
    const zoneChannelSlugs = new Set((zone.channels || []).map((c) => c.slug));
    for (const warehouse of zone.warehouses || []) {
      const warehouseChannelSlugs = warehouseChannelMap.get(warehouse.id) || new Set();
      const sharesChannel = [...zoneChannelSlugs].some((slug) => warehouseChannelSlugs.has(slug));
      if (!sharesChannel) {
        orphaned.push({
          zoneId: zone.id,
          zoneName: zone.name,
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          zoneChannelSlugs: [...zoneChannelSlugs].sort(),
        });
      }
    }
  }
  return orphaned;
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

async function fetchZonesAndChannels() {
  const data = await gql(ZONES_AND_CHANNELS_QUERY);
  const zones = data.shippingZones.edges.map((e) => e.node);
  const channels = data.channels.edges.map((e) => e.node);
  return { zones, channels };
}

async function detachWarehouse(zoneId, warehouseId) {
  const result = (await gql(REMOVE_WAREHOUSES_MUTATION, { id: zoneId, warehouseIds: [warehouseId] })).shippingZoneUpdate;
  if (result.shippingErrors.length) throw new Error(JSON.stringify(result.shippingErrors));
}

export async function run() {
  const repair = process.argv.includes("--repair");

  const { zones, channels } = await fetchZonesAndChannels();
  const warehouseChannelMap = buildWarehouseChannelMap(channels);
  const orphaned = findOrphanedWarehouseZoneLinks(zones, warehouseChannelMap);

  if (orphaned.length === 0) {
    console.log("Every zone's warehouses share at least one channel with the zone.");
    return;
  }

  for (const pair of orphaned) {
    console.warn(`Zone ${pair.zoneName} has warehouse ${pair.warehouseName} with no shared channel (zone channels: ${pair.zoneChannelSlugs})`);
    if (repair) {
      console.log(`${DRY_RUN ? "Would" : "Will"} remove warehouse ${pair.warehouseName} from zone ${pair.zoneName}`);
      if (!DRY_RUN) await detachWarehouse(pair.zoneId, pair.warehouseId);
    } else {
      console.log("Add a shared channel or rerun with --repair to detach. Not modified.");
    }
  }

  console.log(`Done. ${orphaned.length} orphaned warehouse-zone pair(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
