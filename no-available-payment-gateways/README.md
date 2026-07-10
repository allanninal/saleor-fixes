# No available payment gateways despite plugin enabled

In Saleor 3.x a payment integration's enabled state is not one global switch. A legacy plugin has a `globalConfiguration.active` flag plus a separate `channelConfigurations` list, one `PluginConfiguration` per channel, each with its own `active` flag. A payment app instead has to subscribe to the `PAYMENT_LIST_GATEWAYS` sync webhook and return gateway entries whose `currencies` array matches the channel's currency. Staff often toggle a plugin on globally, or activate it for one channel, without noticing the storefront's channel has `active: false` in its own configuration, or that an app's webhook response never mentions that channel's currency. Either way `checkout.availablePaymentGateways` and `shop.availablePaymentGateways(channel: ...)` resolve to an empty list with no error.

This script enumerates channels, checks the live `availablePaymentGateways` per channel, then cross references plugin `channelConfigurations` and payment app activation and currency coverage with a pure function, `decide_gateway_gap` / `decideGatewayGap`. It reports each broken channel with the exact reasons: `plugin_inactive_for_channel`, `app_disabled`, or `currency_mismatch`. It never writes blindly, a `pluginUpdate` repair is only ever printed under `DRY_RUN`, and only once you have confirmed by hand that the channel's plugin configuration is otherwise valid.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/no-available-payment-gateways/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export DRY_RUN="true"

python no-available-payment-gateways/python/find_gateway_gaps.py
node   no-available-payment-gateways/node/find-gateway-gaps.js
```

`decide_gateway_gap` is a pure function: given a channel, the plugin's per-channel configurations, and every payment app's activation and gateway currency data (all pre-fetched arrays, no network or DB calls inside it), it returns `{channelSlug, hasAvailableGateway, reasons}`. A channel passes only when at least one plugin channel configuration is active, or at least one active app returns a gateway whose currencies include the channel's currency. The script never sends `pluginUpdate` itself, it only reports and, under `DRY_RUN=true`, prints the mutation a human could review and run once the channel's configuration is confirmed correct.

## Test

```bash
pytest no-available-payment-gateways/python
node --test no-available-payment-gateways/node
```
