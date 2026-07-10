"""Catch an invalid Saleor channel slug before a channel-scoped query silently
returns nothing.

Saleor's channel-scoped queries, such as products, product, productVariant, and
productVariants, resolve the channel argument by filtering ChannelListing and
availability records against the slug string you pass. They never first check
that a Channel with that slug exists. A typo, a renamed channel, or a deleted
channel simply matches zero listings, so the query returns an empty result set
instead of an error, unlike mutations such as checkoutCreate which raise
CheckoutErrorCode.NOT_FOUND for the same situation (see saleor/saleor#16186).

This script fetches the real channel list once with channels { slug isActive },
then lets you validate any slug your integration is about to use with a pure
decision function before the channel-scoped query ever runs. It never writes
to Saleor. It only reads channels and reports.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("validate_channel_slug")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Slugs your integration passes to channel-scoped queries, e.g. gathered from
# config, environment variables, or scanning your own script's call sites.
CANDIDATE_SLUGS = [
    s.strip() for s in os.environ.get("CANDIDATE_CHANNEL_SLUGS", "").split(",") if s.strip()
]

SUGGESTION_MAX_DISTANCE = 3

CHANNELS_QUERY = """
query {
  channels { id slug name isActive }
}"""


class InvalidChannelSlugError(Exception):
    pass


def gql(query, variables=None):
    r = requests.post(
        API_URL,
        json={"query": query, "variables": variables or {}},
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise RuntimeError(body["errors"])
    return body["data"]


def fetch_channels():
    return gql(CHANNELS_QUERY)["channels"]


def _levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[len(b)]


def decide_channel_slug_validity(requested_slug, known_channels):
    """Pure decision logic. Takes an already-fetched channel list and a candidate
    slug, no network calls. Returns {"status": "VALID"|"INACTIVE"|"UNKNOWN",
    "suggestion": str|None}.

    - Exact slug match: VALID (or INACTIVE if that channel's isActive is false).
    - No exact match: UNKNOWN, with the nearest known slug by edit distance as
      the suggestion (or None if nothing is within a reasonable distance, i.e.
      edit distance <= 3 or a shared two-character prefix).
    """
    for channel in known_channels:
        if channel["slug"] == requested_slug:
            status = "VALID" if channel.get("isActive", True) else "INACTIVE"
            return {"status": status, "suggestion": None}

    best_slug = None
    best_distance = None
    for channel in known_channels:
        slug = channel["slug"]
        distance = _levenshtein(requested_slug, slug)
        shares_prefix = (
            len(requested_slug) >= 2
            and len(slug) >= 2
            and requested_slug[:2] == slug[:2]
        )
        if distance <= SUGGESTION_MAX_DISTANCE or shares_prefix:
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_slug = slug

    return {"status": "UNKNOWN", "suggestion": best_slug}


def require_valid_channel(requested_slug, known_channels, call_site=""):
    decision = decide_channel_slug_validity(requested_slug, known_channels)
    if decision["status"] == "UNKNOWN":
        hint = f" Did you mean '{decision['suggestion']}'?" if decision["suggestion"] else ""
        raise InvalidChannelSlugError(
            f"Channel slug '{requested_slug}' does not exist"
            f"{' (' + call_site + ')' if call_site else ''}.{hint}"
        )
    if decision["status"] == "INACTIVE":
        log.warning("Channel slug '%s' is real but inactive (%s).", requested_slug, call_site)
    return decision


def run():
    known_channels = fetch_channels()
    log.info("Fetched %d channel(s) from Saleor.", len(known_channels))

    if not CANDIDATE_SLUGS:
        log.info(
            "No CANDIDATE_CHANNEL_SLUGS set. Set it to a comma separated list of "
            "slugs your integration uses to check them against the real list."
        )
        return

    problems = 0
    for slug in CANDIDATE_SLUGS:
        try:
            decision = require_valid_channel(slug, known_channels, call_site="CANDIDATE_CHANNEL_SLUGS")
        except InvalidChannelSlugError as err:
            problems += 1
            log.error(str(err))
            continue
        log.info("Channel slug '%s' is %s.", slug, decision["status"])

    if problems and not DRY_RUN:
        raise InvalidChannelSlugError(
            f"{problems} channel slug(s) failed validation. Fix your config before querying Saleor."
        )
    log.info("Done. %d of %d slug(s) failed validation.", problems, len(CANDIDATE_SLUGS))


if __name__ == "__main__":
    run()
