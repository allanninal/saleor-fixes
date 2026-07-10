/**
 * Find Saleor products that have zero variants, report them, and optionally
 * unpublish the ones that are still published to a channel.
 *
 * Saleor stores price, SKU, stock, and channel availability on the
 * ProductVariant, not the Product. A product created without ever calling
 * productVariantCreate has defaultVariant === null and can crash or silently
 * break pricing and availability for storefront and checkout code.
 *
 * There is no safe auto-fix: Saleor cannot invent a SKU, price, or stock
 * quantity. This is flag and report, with an optional per-channel unpublish
 * gated by DRY_RUN. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/saleor/product-without-variant-crashes-queries/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://demo.saleor.io/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "token_dummy";
const CHANNEL_SLUG = process.env.SALEOR_CHANNEL_SLUG || "default-channel";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function classifyVariantHealth(product) {
  if ((product.variants || []).length > 0) {
    return { status: "OK", affectedChannels: [] };
  }

  const affectedChannels = (product.channelListings || [])
    .filter((cl) => cl.isPublished)
    .map((cl) => cl.channel.slug);

  const status = affectedChannels.length > 0 ? "NO_VARIANTS_PUBLISHED" : "NO_VARIANTS_UNPUBLISHED";
  return { status, affectedChannels };
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

const PRODUCTS_QUERY = `
query($cursor: String, $channel: String) {
  products(first: 100, after: $cursor, channel: $channel) {
    edges {
      node {
        id
        name
        slug
        defaultVariant { id }
        variants { id }
        channelListings { channel { id slug } isPublished }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const UNPUBLISH_MUTATION = `
mutation($productId: ID!, $channelId: ID!) {
  productChannelListingUpdate(id: $productId, input: {
    updateChannels: [{ channelId: $channelId, isPublished: false }]
  }) {
    product { id }
    errors { field message }
  }
}`;

async function* allProducts(channelSlug) {
  let cursor = null;
  while (true) {
    const data = (await gql(PRODUCTS_QUERY, { cursor, channel: channelSlug })).products;
    for (const edge of data.edges) yield edge.node;
    if (!data.pageInfo.hasNextPage) return;
    cursor = data.pageInfo.endCursor;
  }
}

async function unpublishProductChannel(productId, channelId) {
  const result = (await gql(UNPUBLISH_MUTATION, { productId, channelId })).productChannelListingUpdate;
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return result.product.id;
}

export async function run() {
  const mode = DRY_RUN ? "dry run" : "live";
  console.log(`Scanning products on channel ${CHANNEL_SLUG} (${mode})`);

  let flagged = 0;
  let unpublished = 0;
  for await (const node of allProducts(CHANNEL_SLUG)) {
    const result = classifyVariantHealth(node);
    if (result.status === "OK") continue;

    flagged++;
    console.warn(
      `${result.status} product=${node.name} (${node.slug}) affectedChannels=${result.affectedChannels.join(",")}`
    );

    if (result.status === "NO_VARIANTS_PUBLISHED" && !DRY_RUN) {
      const channelsBySlug = Object.fromEntries(
        node.channelListings.map((cl) => [cl.channel.slug, cl.channel.id])
      );
      for (const slug of result.affectedChannels) {
        const channelId = channelsBySlug[slug];
        if (channelId) {
          await unpublishProductChannel(node.id, channelId);
          unpublished++;
        }
      }
    }
  }

  console.log(
    `Done. ${flagged} product(s) flagged, ${unpublished} channel listing(s) ${DRY_RUN ? "would be unpublished" : "unpublished"}.`
  );
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
