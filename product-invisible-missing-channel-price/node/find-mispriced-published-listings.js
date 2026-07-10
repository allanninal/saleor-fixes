/**
 * Flag Saleor products published to a channel with no usable price there.
 *
 * Publishing a product to a channel (ProductChannelListing.isPublished = true) and
 * pricing it for that channel (ProductVariantChannelListing.price) are two separate
 * steps in Saleor. A variant can be published without ever being priced, most often
 * while onboarding a new channel or bulk importing. The pricing resolvers then return
 * null and the storefront cannot show or sell the product, while the API still calls
 * it published. This queries products for a channel with their channel listings and
 * each variant's channel listings, cross references them by channel slug with a pure
 * function, and reports every variant that is published without a usable price. It
 * never invents a price. The only write it can perform, unpublishing the broken
 * listing, is gated by DRY_RUN and meant to run only after a human has decided
 * suppressing visibility is the right call.
 *
 * Guide: https://www.allanninal.dev/saleor/product-invisible-missing-channel-price/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const CHANNEL_SLUG = process.env.SALEOR_CHANNEL_SLUG || "default-channel";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRODUCTS_QUERY = `
query($channel: String!, $cursor: String) {
  products(channel: $channel, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        channelListings { channel { slug } isPublished isAvailableForPurchase
          pricing { priceRange { start { gross { amount currency } } } } }
        variants {
          id
          name
          channelListings { channel { slug } price { amount currency } costPrice { amount } }
        }
      }
    }
  }
}`;

const UNPUBLISH_MUTATION = `
mutation($productId: ID!, $channelId: ID!) {
  productChannelListingUpdate(id: $productId, input: {
    updateChannels: [{ channelId: $channelId, isPublished: false }]
  }) {
    errors { field message code }
  }
}`;

export function normalizeProduct(raw) {
  return {
    id: raw.id,
    channelListings: (raw.channelListings || []).map((cl) => ({
      channelSlug: cl.channel.slug,
      isPublished: cl.isPublished,
    })),
    variants: (raw.variants || []).map((v) => ({
      id: v.id,
      channelListings: (v.channelListings || []).map((cl) => ({
        channelSlug: cl.channel.slug,
        priceAmount: cl.price ? cl.price.amount : null,
      })),
    })),
  };
}

/**
 * Pure decision logic. No network or DB calls.
 *
 * Takes an array of normalized products, each shaped as:
 *   {
 *     id: string,
 *     channelListings: [{ channelSlug: string, isPublished: boolean }, ...],
 *     variants: [
 *       { id: string, channelListings: [{ channelSlug: string, priceAmount: number|null }, ...] },
 *       ...
 *     ],
 *   }
 *
 * Returns an array of:
 *   { productId: string, variantId: string, channelSlug: string, reason: "missing_price"|"zero_price" }
 */
export function findMispricedPublishedListings(products) {
  const flagged = [];
  for (const product of products) {
    for (const listing of product.channelListings || []) {
      if (!listing.isPublished) continue;
      const channelSlug = listing.channelSlug;
      for (const variant of product.variants || []) {
        const variantListing = (variant.channelListings || []).find(
          (cl) => cl.channelSlug === channelSlug
        );
        let reason;
        if (!variantListing || variantListing.priceAmount === null || variantListing.priceAmount === undefined) {
          reason = "missing_price";
        } else if (variantListing.priceAmount <= 0) {
          reason = "zero_price";
        } else {
          continue;
        }
        flagged.push({
          productId: product.id,
          variantId: variant.id,
          channelSlug,
          reason,
        });
      }
    }
  }
  return flagged;
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

async function fetchProducts(channelSlug) {
  let cursor = null;
  const products = [];
  while (true) {
    const data = (await gql(PRODUCTS_QUERY, { channel: channelSlug, cursor })).products;
    for (const edge of data.edges) products.push(edge.node);
    if (!data.pageInfo.hasNextPage) return products;
    cursor = data.pageInfo.endCursor;
  }
}

// Only call this after a human has confirmed suppressing visibility is wanted.
export async function unpublishListing(productId, channelId) {
  const result = (await gql(UNPUBLISH_MUTATION, { productId, channelId })).productChannelListingUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
}

export async function run() {
  const rawProducts = await fetchProducts(CHANNEL_SLUG);
  const products = rawProducts.map(normalizeProduct);
  const flagged = findMispricedPublishedListings(products);

  if (flagged.length === 0) {
    console.log(`Every published listing on channel ${CHANNEL_SLUG} has a usable price.`);
    return;
  }

  for (const item of flagged) {
    console.warn(
      `Product ${item.productId} variant ${item.variantId} is published on channel ${item.channelSlug} with ${item.reason}.`
    );
    if (!DRY_RUN) {
      console.log(
        "DRY_RUN is false, but this script only reports by default. "
        + "Call unpublishListing(productId, channelId) yourself once a human has "
        + "confirmed suppressing visibility is the right call. The correct fix is "
        + "productVariantChannelListingUpdate with a real price, run by a merchandiser."
      );
    }
  }

  console.log(`Done. ${flagged.length} variant listing(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
