"""Flag Saleor channels at risk of checkoutLinesAdd failing for anonymous carts.

A channel is at risk when it has no defaultCountry and no warehouse with click and
collect enabled, or when its defaultCountry falls outside its own shipping zones with
no pickup fallback either way. In both cases Saleor cannot resolve a warehouse for a
cart that has no shipping address yet, and checkoutCreate or checkoutLinesAdd returns
a misleading INSUFFICIENT_STOCK style error even though a warehouse holds real stock.

Reports by default. Only applies a repair (channelUpdate) when DRY_RUN=false is
explicitly set and FIX_DEFAULT_COUNTRY is provided, since the correct default country
or pickup warehouse is a business decision this script cannot infer safely.

Guide: https://www.allanninal.dev/saleor/checkout-lines-add-fails-no-country/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_checkout_country_risk")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
FIX_COUNTRY = os.environ.get("FIX_DEFAULT_COUNTRY")  # e.g. "US", only used if DRY_RUN is false

CHANNELS_QUERY = """
query {
  channels {
    id
    slug
    defaultCountry { code }
    warehouses { id clickAndCollectOption }
  }
}"""

CHANNEL_UPDATE = """
mutation($id: ID!, $defaultCountry: CountryCode!) {
  channelUpdate(id: $id, input: { defaultCountry: $defaultCountry }) {
    channel { id defaultCountry { code } }
    errors { field message }
  }
}"""

CHECKOUT_CREATE = """
mutation($channel: String!, $variantId: ID!) {
  checkoutCreate(input: { channel: $channel, lines: [{ variantId: $variantId, quantity: 1 }] }) {
    checkout { id }
    errors { field code message }
  }
}"""


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


def classify_checkout_country_risk(channel):
    """Pure decision logic, no I/O.

    channel: {
        "defaultCountry": str | None,
        "warehouses": [{"clickAndCollectOption": "LOCAL_STOCK" | "ALL_WAREHOUSES" | "DISABLED"}],
        "shippingZoneCountries": [str],
    }
    returns: {"atRisk": bool, "reason": str}
    """
    default_country = channel.get("defaultCountry")
    warehouses = channel.get("warehouses") or []
    shipping_zone_countries = channel.get("shippingZoneCountries") or []

    has_pickup = any(w.get("clickAndCollectOption") != "DISABLED" for w in warehouses)

    if not default_country and not has_pickup:
        return {"atRisk": True, "reason": "no_default_country_no_pickup"}

    if default_country and default_country not in shipping_zone_countries and not has_pickup:
        return {"atRisk": True, "reason": "default_country_outside_shipping_zone"}

    return {"atRisk": False, "reason": "ok"}


def list_channels():
    channels = gql(CHANNELS_QUERY)["channels"]
    for channel in channels:
        country = channel.get("defaultCountry") or {}
        channel["defaultCountry"] = country.get("code")
    return channels


def apply_default_country(channel_id, country_code):
    result = gql(CHANNEL_UPDATE, {"id": channel_id, "defaultCountry": country_code})["channelUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["channel"]["defaultCountry"]["code"]


def reproduce_failure(channel_slug, variant_id, stock_quantity):
    """Confirm the bug live: an anonymous checkoutCreate with no shippingAddress
    against a real in-stock variant returns a stock error even though stock > 0."""
    result = gql(CHECKOUT_CREATE, {"channel": channel_slug, "variantId": variant_id})["checkoutCreate"]
    errors = result["errors"] or []
    stock_error = any("STOCK" in (e.get("code") or "") for e in errors)
    return stock_error and stock_quantity > 0


def run():
    channels = list_channels()
    flagged = 0
    for channel in channels:
        verdict = classify_checkout_country_risk(channel)
        if not verdict["atRisk"]:
            continue
        flagged += 1
        log.warning(
            "Channel %s at risk (%s). Suggested fix: %s",
            channel["slug"],
            verdict["reason"],
            "set defaultCountry, or enable click and collect on a warehouse",
        )
        if not DRY_RUN and FIX_COUNTRY:
            new_code = apply_default_country(channel["id"], FIX_COUNTRY)
            log.info("Channel %s defaultCountry set to %s", channel["slug"], new_code)
    log.info("Done. %d channel(s) at risk.", flagged)


if __name__ == "__main__":
    run()
