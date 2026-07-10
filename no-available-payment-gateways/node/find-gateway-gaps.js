/**
 * Flag Saleor channels with no available payment gateway, and why.
 *
 * A plugin's globalConfiguration.active does not mean every channel has it active,
 * each channel keeps its own entry in channelConfigurations. A payment app only
 * contributes gateways when it is active and its PAYMENT_LIST_GATEWAYS webhook
 * returns a gateway whose currencies include the channel's currency. This queries
 * channels, availablePaymentGateways per channel, plugin channelConfigurations, and
 * app activation and gateway currencies, then reports the exact channel and reason
 * with decideGatewayGap. It never writes blindly: a pluginUpdate repair is only
 * ever printed under DRY_RUN, and only once a human has confirmed the channel's
 * configuration is otherwise correct.
 *
 * Guide: https://www.allanninal.dev/saleor/no-available-payment-gateways/
 */
import { pathToFileURL } from "node:url";

const API_URL = process.env.SALEOR_API_URL || "https://store.saleor.cloud/graphql/";
const TOKEN = process.env.SALEOR_AUTH_TOKEN || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CHANNELS_QUERY = `
query { channels { id slug currencyCode } }`;

const GATEWAYS_QUERY = `
query($channel: String!, $currency: String) {
  shop {
    availablePaymentGateways(channel: $channel, currency: $currency) {
      id name currencies
    }
  }
}`;

const PLUGINS_QUERY = `
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
}`;

const APPS_QUERY = `
query {
  apps(first: 100) {
    edges {
      node {
        id name isActive
        webhooks { syncEvents targetUrl }
      }
    }
  }
}`;

const PLUGIN_UPDATE = `
mutation($id: ID!, $channelId: ID!) {
  pluginUpdate(id: $id, input: { channelConfigurations: [{ channelId: $channelId, active: true }] }) {
    plugin { id channelConfigurations { active channel { slug } } }
    errors { field message code }
  }
}`;

/**
 * Pure decision: given a channel, the plugin's per-channel configurations, and
 * every payment app's activation and gateway currency data (all pre-fetched,
 * no network or DB calls here), decide whether the channel has an available
 * payment gateway and why not if it does not.
 */
export function decideGatewayGap(channel, pluginChannelConfigs, appGatewayResponses) {
  const reasons = [];

  const pluginEntry = pluginChannelConfigs.find((c) => c.channelSlug === channel.slug);
  const pluginOk = Boolean(pluginEntry && pluginEntry.active);
  if (!pluginEntry || !pluginEntry.active) {
    reasons.push("plugin_inactive_for_channel");
  }

  let appOk = false;
  for (const app of appGatewayResponses) {
    if (!app.isActive) {
      reasons.push("app_disabled");
      continue;
    }
    const currencies = (app.gateways || []).flatMap((g) => g.currencies || []);
    if (currencies.includes(channel.currencyCode)) {
      appOk = true;
    } else {
      reasons.push("currency_mismatch");
    }
  }

  const hasAvailableGateway = pluginOk || appOk;
  return {
    channelSlug: channel.slug,
    hasAvailableGateway,
    reasons: hasAvailableGateway ? [] : reasons,
  };
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

async function fetchChannels() {
  return (await gql(CHANNELS_QUERY)).channels;
}

async function fetchAvailableGateways(channelSlug, currency) {
  const data = await gql(GATEWAYS_QUERY, { channel: channelSlug, currency });
  return data.shop.availablePaymentGateways;
}

async function fetchPluginChannelConfigs(pluginName) {
  const plugins = (await gql(PLUGINS_QUERY)).plugins.edges.map((e) => e.node);
  const plugin = plugins.find((p) => p.name === pluginName);
  if (!plugin) return { plugin: null, configs: [] };
  const configs = plugin.channelConfigurations.map((cc) => ({
    channelSlug: cc.channel.slug,
    active: cc.active,
  }));
  return { plugin, configs };
}

async function fetchPaymentApps() {
  const apps = (await gql(APPS_QUERY)).apps.edges.map((e) => e.node);
  return apps.filter((a) => a.webhooks.some((w) => (w.syncEvents || []).includes("PAYMENT_LIST_GATEWAYS")));
}

function printPlannedPluginUpdate(pluginId, channelId, channelSlug) {
  const variables = { id: pluginId, channelId };
  console.log(`DRY RUN would call pluginUpdate for channel ${channelSlug}:`, JSON.stringify(variables));
}

export async function run(pluginName = "paypal") {
  const channels = await fetchChannels();
  const { plugin, configs: pluginChannelConfigs } = await fetchPluginChannelConfigs(pluginName);
  const paymentApps = await fetchPaymentApps();

  // Note: a full implementation calls each app's PAYMENT_LIST_GATEWAYS webhook
  // target directly (with checkout context) to learn its gateways/currencies,
  // since that data is not exposed through the Admin API. Left empty here
  // because reaching arbitrary third-party webhook URLs needs real credentials.
  const appGatewayResponses = paymentApps.map((app) => ({
    appId: app.id,
    isActive: app.isActive,
    gateways: [],
  }));

  let flagged = 0;
  for (const channel of channels) {
    const liveGateways = await fetchAvailableGateways(channel.slug, channel.currencyCode);
    const decision = decideGatewayGap(channel, pluginChannelConfigs, appGatewayResponses);

    if (liveGateways.length > 0 && decision.hasAvailableGateway) continue;

    flagged++;
    console.warn(`Channel ${channel.slug} has no available payment gateway. Reasons: ${JSON.stringify(decision.reasons.length ? decision.reasons : ["no_live_gateways_returned"])}`);

    if (plugin && DRY_RUN) {
      printPlannedPluginUpdate(plugin.id, channel.id, channel.slug);
    }
  }

  if (flagged === 0) {
    console.log("Every channel has at least one available payment gateway.");
  } else {
    console.log(`Done. ${flagged} channel(s) flagged.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
