/**
 * Flag Saleor variants whose stock is unreachable from a channel, and why.
 *
 * A ProductVariant is only purchasable in a channel when its Stock.warehouse is
 * directly assigned to that channel (Channel.warehouses), and, only when the store
 * still has Shop.useLegacyShippingZoneStockAvailability enabled, when the warehouse's
 * ShippingZone is also attached to that channel and covers the customer's destination
 * country. Because warehouse-to-channel and warehouse-to-zone-to-channel are separate
 * many-to-many links, it is easy to add a warehouse with real stock and forget one of
 * them. quantityAvailable then resolves to 0 even though Stock.quantity is positive.
 *
 * This queries the shop's legacy stock flag, one channel's assigned warehouses, and
 * each variant's stocks with their warehouse channels and shipping zones, then runs a
 * pure decision function to report every stock row that is unreachable from the
 * requested channel. It never mutates merchant topology by default: channelUpdate and
 * shippingZoneUpdate are only ever printed under DRY_RUN, after a human confirms the
 * intended zone/channel.
 *
 * Guide: https://www.allanninal.dev/saleor/product-unavailable-warehouse-zone-channel-mismatch/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SHOP_QUERY = `
query { shop { useLegacyShippingZoneStockAvailability } }`;

const CHANNEL_QUERY = `
query($id: ID!) {
  channel(id: $id) {
    id slug
    warehouses { id }
  }
}`;

const VARIANT_STOCKS_QUERY = `
query($id: ID!, $channel: String!) {
  productVariant(id: $id, channel: $channel) {
    id
    quantityAvailable
    stocks {
      quantity
      warehouse {
        id
        name
        channels { slug }
        shippingZones(first: 100) {
          edges {
            node {
              id
              channels { slug }
              countries { code }
            }
          }
        }
      }
    }
  }
}`;

const CHANNEL_UPDATE = `
mutation($id: ID!, $input: ChannelUpdateInput!) {
  channelUpdate(id: $id, input: $input) {
    channel { id warehouses { id } }
    errors { field message }
  }
}`;

const SHIPPING_ZONE_UPDATE = `
mutation($id: ID!, $input: ShippingZoneUpdateInput!) {
  shippingZoneUpdate(id: $id, input: $input) {
    shippingZone { id channels { slug } warehouses { id } }
    errors { field message }
  }
}`;

/**
 * Pure decision function. No I/O, fully deterministic.
 *
 * variants: VariantStockRecord[]
 *   { variantId, warehouseId, quantity, warehouseChannelSlugs: string[],
 *     warehouseZones: { id, channelSlugs: string[], countries: string[] }[] }
 * channel: { slug, warehouseIds: Set<string> }
 * legacyMode: boolean
 * destinationCountry: optional string
 *
 * Returns a list of {variantId, warehouseId, reason} for every stock row that
 * is unreachable from the requested channel (+ optional destination), i.e.
 * would report quantityAvailable=0 despite quantity > 0 in the raw Stock row.
 */
export function findOrphanedStock(variants, channel, legacyMode, destinationCountry) {
  const issues = [];
  for (const record of variants) {
    if (!(record.quantity > 0)) continue;

    if (!(record.warehouseChannelSlugs || []).includes(channel.slug)) {
      issues.push({
        variantId: record.variantId,
        warehouseId: record.warehouseId,
        reason: "warehouse not linked to channel",
      });
      continue;
    }

    if (legacyMode) {
      const matchingZone = (record.warehouseZones || []).find(
        (z) =>
          (z.channelSlugs || []).includes(channel.slug) &&
          (!destinationCountry || (z.countries || []).includes(destinationCountry))
      );
      if (!matchingZone) {
        issues.push({
          variantId: record.variantId,
          warehouseId: record.warehouseId,
          reason: "warehouse zone not linked to channel/destination",
        });
      }
    }
  }
  return issues;
}

/** Flatten one productVariant GraphQL response into VariantStockRecord rows. */
export function toVariantStockRecords(variantId, variantData) {
  const stocks = variantData?.stocks || [];
  return stocks.map((stock) => {
    const warehouse = stock.warehouse || {};
    return {
      variantId,
      warehouseId: warehouse.id,
      quantity: stock.quantity || 0,
      warehouseChannelSlugs: (warehouse.channels || []).map((c) => c.slug),
      warehouseZones: ((warehouse.shippingZones || {}).edges || []).map((edge) => ({
        id: edge.node.id,
        channelSlugs: (edge.node.channels || []).map((c) => c.slug),
        countries: (edge.node.countries || []).map((c) => c.code),
      })),
    };
  });
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

async function fetchLegacyMode() {
  return (await gql(SHOP_QUERY)).shop.useLegacyShippingZoneStockAvailability;
}

async function fetchChannelGraph(channelId) {
  const data = (await gql(CHANNEL_QUERY, { id: channelId })).channel;
  return {
    slug: data.slug,
    warehouseIds: new Set((data.warehouses || []).map((w) => w.id)),
  };
}

async function fetchVariantRecords(variantId, channelSlug) {
  const data = (await gql(VARIANT_STOCKS_QUERY, { id: variantId, channel: channelSlug })).productVariant;
  if (!data) return [];
  return toVariantStockRecords(variantId, data);
}

function printPlannedChannelUpdate(channelId, warehouseId) {
  const variables = { id: channelId, input: { addWarehouses: [warehouseId] } };
  console.log("DRY RUN would call channelUpdate:", JSON.stringify(variables));
}

function printPlannedZoneUpdate(zoneId, warehouseId, channelId) {
  const variables = { id: zoneId, input: { addWarehouses: [warehouseId], addChannels: [channelId] } };
  console.log("DRY RUN would call shippingZoneUpdate:", JSON.stringify(variables));
}

export async function run() {
  const channelId = process.env.SALEOR_CHANNEL_ID;
  const variantIds = (process.env.SALEOR_VARIANT_IDS || "").split(",").filter(Boolean);

  const legacyMode = await fetchLegacyMode();
  const channel = await fetchChannelGraph(channelId);

  const allRecords = [];
  for (const variantId of variantIds) {
    allRecords.push(...(await fetchVariantRecords(variantId, channel.slug)));
  }

  const issues = findOrphanedStock(allRecords, channel, legacyMode);

  if (issues.length === 0) {
    console.log(`No orphaned stock found for channel ${channel.slug}.`);
    return;
  }

  for (const issue of issues) {
    console.warn(
      `Variant ${issue.variantId} has stock in warehouse ${issue.warehouseId} that is unreachable from channel ${channel.slug}: ${issue.reason}`
    );
    if (DRY_RUN) {
      if (issue.reason === "warehouse not linked to channel") {
        printPlannedChannelUpdate(channelId, issue.warehouseId);
      } else {
        console.log(
          "Zone repair needs a zone id, which this report does not choose automatically. "
            + "Review the warehouse's shippingZones and pick the correct one before calling shippingZoneUpdate."
        );
      }
    }
  }

  console.log(`Done. ${issues.length} orphaned stock row(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
