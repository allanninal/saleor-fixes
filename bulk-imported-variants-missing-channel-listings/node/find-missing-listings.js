/**
 * Find Saleor variants that a bulk import left with no channel listing at
 * all for one or more of the product's channels.
 *
 * productVariantCreate and productVariantBulkCreate do not automatically
 * make a variant sellable anywhere. Channel listings, price, cost price,
 * and publication, live in a separate ProductVariantChannelListing row that
 * must be set explicitly, either via the channelListings input on bulk
 * create or a follow-up productVariantChannelListingUpdate call. Import
 * scripts that only send sku, attributes, and stocks, or that partially
 * fail mid-batch, can leave a variant with zero listing rows, so it never
 * shows a price and never appears in checkout even though the product
 * looks published (saleor/saleor discussion #9731, saleor/saleor#8589).
 *
 * This script never invents a price. Under DRY_RUN=true (the default) it
 * only reports the variant and channel gaps. When DRY_RUN=false it fills a
 * gap only when a price is available from a supplied price map, never
 * guessing. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/bulk-imported-variants-missing-channel-listings/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy-token";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 *
 * For each variantId in importedVariantIds, look up the channel slugs it
 * currently has listings for in variantChannelListings (a prebuilt map from
 * earlier API responses), compute the missing channels as the set
 * difference against productChannelSlugs, and return
 * { [variantId]: sortedMissing } only for variants where missing is
 * non-empty.
 */
export function findMissingChannelListings(importedVariantIds, variantChannelListings, productChannelSlugs) {
  const result = {};
  for (const variantId of importedVariantIds) {
    const have = new Set(variantChannelListings[variantId] || []);
    const missing = productChannelSlugs.filter((slug) => !have.has(slug)).sort();
    if (missing.length) {
      result[variantId] = missing;
    }
  }
  return result;
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

const PRODUCT_QUERY = `
query($id: ID!) {
  product(id: $id) {
    id
    name
    channelListings { channel { id slug } }
    variants {
      id
      sku
      channelListings { channel { slug } price { amount currency } }
    }
  }
}`;

const CHANNEL_LISTING_UPDATE = `
mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
  productVariantChannelListingUpdate(id: $id, input: $input) {
    variant { id channelListings { channel { slug } price { amount } } }
    errors { field message code }
  }
}`;

async function productWithVariants(productId) {
  const data = (await gql(PRODUCT_QUERY, { id: productId })).product;
  const channelIdsBySlug = {};
  for (const cl of data.channelListings) channelIdsBySlug[cl.channel.slug] = cl.channel.id;
  const productChannelSlugs = Object.keys(channelIdsBySlug);
  const variantChannelListings = {};
  for (const v of data.variants) {
    variantChannelListings[v.id] = v.channelListings.map((cl) => cl.channel.slug);
  }
  return { productChannelSlugs, channelIdsBySlug, variantChannelListings, variants: data.variants };
}

async function fillMissingListing(variantId, channelId, price) {
  const result = (await gql(CHANNEL_LISTING_UPDATE, {
    id: variantId,
    input: [{ channelId, price }],
  })).productVariantChannelListingUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.variant;
}

/**
 * priceMap keys are `${variantId}:${channelSlug}` strings mapping to a
 * price. Only gaps present in priceMap are ever written; everything else is
 * reported only, even with DRY_RUN=false.
 */
export async function run(productId, importedVariantIds = null, priceMap = new Map()) {
  const { productChannelSlugs, channelIdsBySlug, variantChannelListings, variants } = await productWithVariants(productId);
  const variantIds = importedVariantIds || variants.map((v) => v.id);

  const gaps = findMissingChannelListings(variantIds, variantChannelListings, productChannelSlugs);

  for (const [variantId, missingSlugs] of Object.entries(gaps)) {
    console.warn(`Variant ${variantId} missing channel listing for: ${missingSlugs.join(", ")}`);
  }

  if (Object.keys(gaps).length === 0) {
    console.log("Done. No missing channel listings found.");
    return gaps;
  }

  if (DRY_RUN) {
    console.log(`Done. ${Object.keys(gaps).length} variant(s) with gaps reported, dry run on.`);
    return gaps;
  }

  let filled = 0;
  for (const [variantId, missingSlugs] of Object.entries(gaps)) {
    for (const slug of missingSlugs) {
      const price = priceMap.get(`${variantId}:${slug}`);
      if (price === undefined) {
        console.warn(`No price source for variant ${variantId} channel ${slug}, skipping.`);
        continue;
      }
      await fillMissingListing(variantId, channelIdsBySlug[slug], price);
      filled++;
    }
  }
  console.log(`Done. ${filled} channel listing(s) filled from a real price source.`);
  return gaps;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.env.PRODUCT_ID || "").catch((err) => { console.error(err); process.exit(1); });
}
