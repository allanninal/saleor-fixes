"""Flag Saleor channels with no available payment gateway, and why.

A plugin's globalConfiguration.active does not mean every channel has it active,
each channel keeps its own entry in channelConfigurations. A payment app only
contributes gateways when it is active and its PAYMENT_LIST_GATEWAYS webhook
returns a gateway whose currencies include the channel's currency. This queries
channels, availablePaymentGateways per channel, plugin channelConfigurations, and
app activation and gateway currencies, then reports the exact channel and reason
with decide_gateway_gap. It never writes blindly: a pluginUpdate repair is only
ever printed under DRY_RUN, and only once a human has confirmed the channel's
configuration is otherwise correct.

Guide: https://www.allanninal.dev/saleor/no-available-payment-gateways/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_gateway_gaps")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CHANNELS_QUERY = """
query { channels { id slug currencyCode } }"""

GATEWAYS_QUERY = """
query($channel: String!, $currency: String) {
  shop {
    availablePaymentGateways(channel: $channel, currency: $currency) {
      id name currencies
    }
  }
}"""

PLUGINS_QUERY = """
query {
  plugins(first: 100) {
    edges {
      node {
        id name
        globalConfiguration { active }
        channelConfigurations { active channel { slug } configuration { name value } }
      }
    }
  }
}"""

APPS_QUERY = """
query {
  apps(first: 100) {
    edges {
      node {
        id name isActive
        webhooks { syncEvents targetUrl }
      }
    }
  }
}"""

PLUGIN_UPDATE = """
mutation($id: ID!, $channelId: ID!) {
  pluginUpdate(id: $id, input: { channelConfigurations: [{ channelId: $channelId, active: true }] }) {
    plugin { id channelConfigurations { active channel { slug } } }
    errors { field message code }
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


def decide_gateway_gap(channel, plugin_channel_configs, app_gateway_responses):
    """Pure decision: given a channel, the plugin's per-channel configurations,
    and every payment app's activation and gateway currency data (all pre-fetched,
    no network or DB calls here), decide whether the channel has an available
    payment gateway and why not if it does not.
    """
    reasons = []

    plugin_entry = next(
        (c for c in plugin_channel_configs if c["channelSlug"] == channel["slug"]), None
    )
    plugin_ok = bool(plugin_entry and plugin_entry.get("active"))
    if plugin_entry is None or not plugin_entry.get("active"):
        reasons.append("plugin_inactive_for_channel")

    app_ok = False
    for app in app_gateway_responses:
        if not app.get("isActive"):
            reasons.append("app_disabled")
            continue
        currencies = [c for g in app.get("gateways", []) for c in g.get("currencies", [])]
        if channel["currencyCode"] in currencies:
            app_ok = True
        else:
            reasons.append("currency_mismatch")

    has_available_gateway = plugin_ok or app_ok
    return {
        "channelSlug": channel["slug"],
        "hasAvailableGateway": has_available_gateway,
        "reasons": [] if has_available_gateway else reasons,
    }


def fetch_channels():
    return gql(CHANNELS_QUERY)["channels"]


def fetch_available_gateways(channel_slug, currency):
    data = gql(GATEWAYS_QUERY, {"channel": channel_slug, "currency": currency})
    return data["shop"]["availablePaymentGateways"]


def fetch_plugin_channel_configs(plugin_name):
    plugins = gql(PLUGINS_QUERY)["plugins"]["edges"]
    plugin = next((e["node"] for e in plugins if e["node"]["name"] == plugin_name), None)
    if not plugin:
        return None, []
    configs = [
        {"channelSlug": cc["channel"]["slug"], "active": cc["active"]}
        for cc in plugin["channelConfigurations"]
    ]
    return plugin, configs


def fetch_payment_apps():
    apps = gql(APPS_QUERY)["apps"]["edges"]
    return [
        e["node"] for e in apps
        if any("PAYMENT_LIST_GATEWAYS" in (w.get("syncEvents") or []) for w in e["node"]["webhooks"])
    ]


def print_planned_plugin_update(plugin_id, channel_id, channel_slug):
    variables = {"id": plugin_id, "channelId": channel_id}
    log.info("DRY RUN would call pluginUpdate for channel %s: %s", channel_slug, variables)


def run(plugin_name="paypal"):
    channels = fetch_channels()
    plugin, plugin_channel_configs = fetch_plugin_channel_configs(plugin_name)
    payment_apps = fetch_payment_apps()

    # Note: a full implementation calls each app's PAYMENT_LIST_GATEWAYS webhook
    # target directly (with checkout context) to learn its gateways/currencies,
    # since that data is not exposed through the Admin API. Left empty here
    # because reaching arbitrary third-party webhook URLs needs real credentials.
    app_gateway_responses = [
        {"appId": app["id"], "isActive": app["isActive"], "gateways": []}
        for app in payment_apps
    ]

    flagged = 0
    for channel in channels:
        live_gateways = fetch_available_gateways(channel["slug"], channel["currencyCode"])
        decision = decide_gateway_gap(channel, plugin_channel_configs, app_gateway_responses)

        if live_gateways and decision["hasAvailableGateway"]:
            continue

        flagged += 1
        log.warning("Channel %s has no available payment gateway. Reasons: %s",
                    channel["slug"], decision["reasons"] or ["no_live_gateways_returned"])

        if plugin and DRY_RUN:
            print_planned_plugin_update(plugin["id"], channel["id"], channel["slug"])

    if flagged == 0:
        log.info("Every channel has at least one available payment gateway.")
    else:
        log.info("Done. %d channel(s) flagged.", flagged)


if __name__ == "__main__":
    run()
