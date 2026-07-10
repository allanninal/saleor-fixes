/**
 * Catch an invalid Saleor channel slug before a channel-scoped query silently
 * returns nothing.
 *
 * Saleor's channel-scoped queries, such as products, product, productVariant, and
 * productVariants, resolve the channel argument by filtering ChannelListing and
 * availability records against the slug string you pass. They never first check
 * that a Channel with that slug exists. A typo, a renamed channel, or a deleted
 * channel simply matches zero listings, so the query returns an empty result set
 * instead of an error, unlike mutations such as checkoutCreate which raise
 * CheckoutErrorCode.NOT_FOUND for the same situation (see saleor/saleor#16186).
 *
 * This script fetches the real channel list once with channels { slug isActive },
 * then lets you validate any slug your integration is about to use with a pure
 * decision function before the channel-scoped query ever runs. It never writes
 * to Saleor. It only reads channels and reports.
 *
 * Guide: https://www.allanninal.dev/saleor/invalid-channel-slug-accepted-silently/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Slugs your integration passes to channel-scoped queries, e.g. gathered from
// config, environment variables, or scanning your own script's call sites.
const CANDIDATE_SLUGS = (process.env.CANDIDATE_CHANNEL_SLUGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SUGGESTION_MAX_DISTANCE = 3;

const CHANNELS_QUERY = `
query {
  channels { id slug name isActive }
}`;

export class InvalidChannelSlugError extends Error {}

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

async function fetchChannels() {
  return (await gql(CHANNELS_QUERY)).channels;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Pure decision logic. Takes an already-fetched channel list and a candidate
 * slug, no network calls. Returns { status: "VALID"|"INACTIVE"|"UNKNOWN",
 * suggestion: string|null }.
 *
 * - Exact slug match: VALID (or INACTIVE if that channel's isActive is false).
 * - No exact match: UNKNOWN, with the nearest known slug by edit distance as
 *   the suggestion (or null if nothing is within a reasonable distance, i.e.
 *   edit distance <= 3 or a shared two-character prefix).
 */
export function decideChannelSlugValidity(requestedSlug, knownChannels) {
  for (const channel of knownChannels) {
    if (channel.slug === requestedSlug) {
      const status = channel.isActive === false ? "INACTIVE" : "VALID";
      return { status, suggestion: null };
    }
  }

  let bestSlug = null;
  let bestDistance = null;
  for (const channel of knownChannels) {
    const slug = channel.slug;
    const distance = levenshtein(requestedSlug, slug);
    const sharesPrefix =
      requestedSlug.length >= 2 && slug.length >= 2 && requestedSlug.slice(0, 2) === slug.slice(0, 2);
    if (distance <= SUGGESTION_MAX_DISTANCE || sharesPrefix) {
      if (bestDistance === null || distance < bestDistance) {
        bestDistance = distance;
        bestSlug = slug;
      }
    }
  }

  return { status: "UNKNOWN", suggestion: bestSlug };
}

export function requireValidChannel(requestedSlug, knownChannels, callSite = "") {
  const decision = decideChannelSlugValidity(requestedSlug, knownChannels);
  if (decision.status === "UNKNOWN") {
    const hint = decision.suggestion ? ` Did you mean '${decision.suggestion}'?` : "";
    throw new InvalidChannelSlugError(
      `Channel slug '${requestedSlug}' does not exist${callSite ? ` (${callSite})` : ""}.${hint}`
    );
  }
  if (decision.status === "INACTIVE") {
    console.warn(`Channel slug '${requestedSlug}' is real but inactive (${callSite}).`);
  }
  return decision;
}

export async function run() {
  const knownChannels = await fetchChannels();
  console.log(`Fetched ${knownChannels.length} channel(s) from Saleor.`);

  if (CANDIDATE_SLUGS.length === 0) {
    console.log(
      "No CANDIDATE_CHANNEL_SLUGS set. Set it to a comma separated list of "
      + "slugs your integration uses to check them against the real list."
    );
    return;
  }

  let problems = 0;
  for (const slug of CANDIDATE_SLUGS) {
    try {
      const decision = requireValidChannel(slug, knownChannels, "CANDIDATE_CHANNEL_SLUGS");
      console.log(`Channel slug '${slug}' is ${decision.status}.`);
    } catch (err) {
      problems++;
      console.error(err.message);
    }
  }

  if (problems && !DRY_RUN) {
    throw new InvalidChannelSlugError(
      `${problems} channel slug(s) failed validation. Fix your config before querying Saleor.`
    );
  }
  console.log(`Done. ${problems} of ${CANDIDATE_SLUGS.length} slug(s) failed validation.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
