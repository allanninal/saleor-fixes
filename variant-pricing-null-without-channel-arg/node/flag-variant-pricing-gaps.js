/**
 * Find Saleor product variants that are genuinely missing a price, without
 * being fooled by a channel-less ProductVariant.pricing query.
 *
 * ProductVariant.pricing and Product.pricing resolve against a specific
 * channel's ProductVariantChannelListing. Omit the channel argument and
 * Saleor has no channel context to resolve against, so pricing comes back
 * null for every row, priced or not. This script runs a naive channel-less
 * pass only to show the contrast, then re-queries productVariants once per
 * active channel with channel set, reads channelListings directly, and
 * classifies each variant with a pure function.
 *
 * This is a detection script, not an auto-repair one. Under DRY_RUN=true
 * (the default) it only reports flagged variants. When DRY_RUN=false and a
 * human-supplied price map is provided, it calls
 * productVariantChannelListingUpdate to backfill the approved price. It
 * never invents a price on its own. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/variant-pricing-null-without-channel-arg/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function, no I/O.
 * Returns one of "PRICED", "UNPRICED_MISSING_LISTING",
 * "UNPRICED_NULL_PRICE", "NOT_SOLD_IN_ACTIVE_CHANNEL".
 */
export function classifyVariantPricing(variant, activeChannelSlugs) {
  const active = new Set(activeChannelSlugs);
  const relevant = (variant.channelListings || []).filter((cl) => active.has(cl.channelSlug));

  if (relevant.length === 0) return "NOT_SOLD_IN_ACTIVE_CHANNEL";

  if (relevant.some((cl) => cl.price === null)) return "UNPRICED_NULL_PRICE";

  const listedSlugs = new Set(relevant.map((cl) => cl.channelSlug));
  const missingListing = relevant.some((cl) => cl.isPublished && !listedSlugs.has(cl.channelSlug));
  if (missingListing) return "UNPRICED_MISSING_LISTING";

  return "PRICED";
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

const NAIVE_QUERY = `
query($cursor: String) {
  productVariants(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        pricing { price { gross { amount currency } } }
      }
    }
  }
}`;

const CHANNELS_QUERY = `
query {
  channels { slug isActive }
}`;

const VARIANTS_BY_CHANNEL_QUERY = `
query($cursor: String, $channel: String!) {
  productVariants(first: 50, after: $cursor, channel: $channel) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        channelListings {
          channel { slug }
          isPublished
          price { amount currency }
        }
      }
    }
  }
}`;

const CHANNEL_LISTING_UPDATE = `
mutation($id: ID!, $channelId: ID!, $price: PositiveDecimal!) {
  productVariantChannelListingUpdate(
    id: $id,
    input: [{ channelId: $channelId, price: $price }]
  ) {
    variant { id }
    errors { field message code }
  }
}`;

async function naiveScanSample(sampleSize = 5) {
  const data = (await gql(NAIVE_QUERY, { cursor: null })).productVariants;
  const rows = data.edges.slice(0, sampleSize).map((edge) => edge.node);
  for (const row of rows) {
    console.log(`naive pass sku=${row.sku} pricing=${JSON.stringify(row.pricing)} (always null here)`);
  }
  return rows;
}

async function activeChannelSlugs() {
  const data = (await gql(CHANNELS_QUERY)).channels;
  return data.filter((c) => c.isActive).map((c) => c.slug);
}

async function* variantsForChannel(channelSlug) {
  let cursor = null;
  while (true) {
    const data = (await gql(VARIANTS_BY_CHANNEL_QUERY, { cursor, channel: channelSlug })).productVariants;
    for (const edge of data.edges) {
      const node = edge.node;
      node.channelListings = node.channelListings.map((cl) => ({
        channelSlug: cl.channel.slug,
        isPublished: cl.isPublished,
        price: cl.price,
      }));
      yield node;
    }
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function backfillPrice(variantId, channelId, price) {
  const result = (await gql(CHANNEL_LISTING_UPDATE, { id: variantId, channelId, price })).productVariantChannelListingUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
}

/**
 * approvedPriceMap: optional object keyed "variantId::channelSlug" -> { channelId, price }
 * supplied by a human. Nothing is ever backfilled without an explicit entry here
 * and DRY_RUN=false.
 */
export async function run(approvedPriceMap = {}) {
  await naiveScanSample();

  const channels = await activeChannelSlugs();
  const seen = new Map();
  const flagged = [];
  for (const slug of channels) {
    for await (const variant of variantsForChannel(slug)) {
      if (!seen.has(variant.id)) seen.set(variant.id, variant);
    }
    for (const variant of seen.values()) {
      const verdict = classifyVariantPricing(variant, channels);
      if (verdict === "PRICED") continue;
      const entry = { variantId: variant.id, sku: variant.sku, channelSlug: slug, reason: verdict };
      flagged.push(entry);
      console.warn(`UNPRICED sku=${entry.sku} channel=${entry.channelSlug} reason=${entry.reason}`);
    }
  }

  for (const entry of flagged) {
    const approved = approvedPriceMap[`${entry.variantId}::${entry.channelSlug}`];
    if (!approved) continue;
    console.log(`Variant ${entry.sku} eligible for backfill. ${DRY_RUN ? "would backfill" : "backfilling"}`);
    if (!DRY_RUN) await backfillPrice(entry.variantId, approved.channelId, approved.price);
  }

  console.log(`Done. ${flagged.length} variant/channel gap(s) found.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
