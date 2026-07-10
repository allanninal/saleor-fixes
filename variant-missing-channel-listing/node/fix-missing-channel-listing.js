/**
 * Find Saleor variants that have zero ProductVariantChannelListing rows
 * for a channel their own product is published on (saleor/saleor discussions
 * #9731, #9422, and issue #8589). productVariantCreate, productVariantBulkCreate,
 * and CSV importers can all create a variant without attaching a channel price,
 * leaving it unsellable while the product still looks published.
 *
 * This script never guesses a price. Under DRY_RUN=true (the default) it only
 * reports flagged variants and their missing channels. When DRY_RUN=false it
 * looks for a price from a sibling variant on the same product and channel, or
 * a configured default, and calls productVariantChannelListingUpdate only when
 * one of those exists. Channels with no safe price are skipped and reported.
 * Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/saleor/variant-missing-channel-listing/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const CHANNEL = process.env.SALEOR_CHANNEL || "default-channel";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. Takes plain variant rows:
 *   { id, sku, productChannelSlugs: [...], variantChannelSlugs: [...] }
 * and returns the subset missing at least one channel listing, each
 * annotated with missingChannels: [...].
 */
export function findVariantsMissingChannelListing(variants) {
  const flagged = [];
  for (const variant of variants) {
    const variantSlugs = new Set(variant.variantChannelSlugs);
    const missingChannels = variant.productChannelSlugs.filter((slug) => !variantSlugs.has(slug));
    if (missingChannels.length > 0) {
      flagged.push({ id: variant.id, sku: variant.sku, missingChannels });
    }
  }
  return flagged;
}

export function findSiblingPrice(productId, channelSlug, productVariantsIndex) {
  const siblings = productVariantsIndex[productId] || [];
  for (const sibling of siblings) {
    for (const listing of sibling.channelListingsRaw || []) {
      if (listing.channel.slug === channelSlug && listing.price) {
        return listing.price.amount;
      }
    }
  }
  return null;
}

export function resolvePrice(productId, channelSlug, productVariantsIndex, defaultPrices) {
  const siblingPrice = findSiblingPrice(productId, channelSlug, productVariantsIndex);
  if (siblingPrice !== null) return siblingPrice;
  return defaultPrices[channelSlug] ?? null;
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

const VARIANTS_QUERY = `
query($channel: String, $cursor: String) {
  productVariants(first: 100, after: $cursor, channel: $channel) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        sku
        product {
          id
          name
          channelListings { channel { id slug } isPublished }
        }
        channelListings { channel { id slug } price { amount currency } }
      }
    }
  }
}`;

const CHANNEL_LISTING_UPDATE = `
mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
  productVariantChannelListingUpdate(id: $id, input: $input) {
    variant { id }
    errors { field message code }
  }
}`;

async function variantSnapshot(channel) {
  let cursor = null;
  const rows = [];
  const rawByProduct = {};
  const channelIdsBySlug = {};
  while (true) {
    const data = (await gql(VARIANTS_QUERY, { channel, cursor })).productVariants;
    for (const edge of data.edges) {
      const node = edge.node;
      const productId = node.product.id;
      for (const cl of node.product.channelListings) channelIdsBySlug[cl.channel.slug] = cl.channel.id;
      for (const cl of node.channelListings) channelIdsBySlug[cl.channel.slug] = cl.channel.id;
      if (!rawByProduct[productId]) rawByProduct[productId] = [];
      rawByProduct[productId].push({ sku: node.sku, channelListingsRaw: node.channelListings });
      rows.push({
        id: node.id,
        sku: node.sku,
        productId,
        productChannelSlugs: node.product.channelListings
          .filter((cl) => cl.isPublished)
          .map((cl) => cl.channel.slug),
        variantChannelSlugs: node.channelListings.map((cl) => cl.channel.slug),
      });
    }
    if (!data.pageInfo.hasNextPage) return { rows, rawByProduct, channelIdsBySlug };
    cursor = data.pageInfo.endCursor;
  }
}

async function applyListing(variantId, channelId, price) {
  const entry = { channelId, price };
  const result = (await gql(CHANNEL_LISTING_UPDATE, { id: variantId, input: [entry] })).productVariantChannelListingUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.variant;
}

export async function run(defaultPrices = {}) {
  const { rows, rawByProduct, channelIdsBySlug } = await variantSnapshot(CHANNEL);
  const flagged = findVariantsMissingChannelListing(rows);
  const byId = Object.fromEntries(rows.map((v) => [v.id, v]));

  if (DRY_RUN) {
    for (const row of flagged) {
      console.warn(`MISSING sku=${row.sku} variant=${row.id} missing_channels=${row.missingChannels.join(",")}`);
    }
    console.log(`Done (dry run). ${flagged.length} variant(s) missing at least one channel listing.`);
    return flagged;
  }

  let repaired = 0;
  for (const row of flagged) {
    const productId = byId[row.id].productId;
    for (const slug of row.missingChannels) {
      const price = resolvePrice(productId, slug, rawByProduct, defaultPrices);
      const channelId = channelIdsBySlug[slug];
      if (price === null || !channelId) {
        console.log(`Skipping ${row.sku} on ${slug}, no safe price found. Flag for manual pricing.`);
        continue;
      }
      await applyListing(row.id, channelId, price);
      console.log(`Listed ${row.sku} on ${slug} at ${price}.`);
      repaired++;
    }
  }

  console.log(`Done. ${flagged.length} variant(s) flagged, ${repaired} channel listing(s) repaired.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
