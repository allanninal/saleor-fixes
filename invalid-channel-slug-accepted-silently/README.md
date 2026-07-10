# Invalid channel slug accepted without error

Saleor's channel-scoped queries, such as `products`, `product`, `productVariant`, and `productVariants`, resolve the `channel` argument by filtering `ChannelListing` and availability records against the slug string you pass. They never first check that a `Channel` with that slug exists. A typo, a renamed channel, or a deleted channel simply matches zero listings, so the query returns an empty result set instead of an error, unlike mutations such as `checkoutCreate` which raise `CheckoutErrorCode.NOT_FOUND` for the same situation.

This script fetches the real channel list once with `channels { slug isActive }`, then validates any slug your integration is about to use with a pure decision function before the channel-scoped query ever runs. It never writes to Saleor, it only reads `channels` and reports.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/invalid-channel-slug-accepted-silently/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="..."
export CANDIDATE_CHANNEL_SLUGS="us-store,eu-stor,default-channel"
export DRY_RUN="true"

python invalid-channel-slug-accepted-silently/python/validate_channel_slug.py
node   invalid-channel-slug-accepted-silently/node/validate-channel-slug.js
```

`decide_channel_slug_validity` is a pure function: it takes a requested slug and the already-fetched channel list and returns `VALID`, `INACTIVE`, or `UNKNOWN` with a nearest-slug suggestion by edit distance. No network calls happen inside it. The script only reads `channels` and never mutates the store, so `DRY_RUN` just controls whether a failed validation raises at the end of the run.

## Test

```bash
pytest invalid-channel-slug-accepted-silently/python
node --test invalid-channel-slug-accepted-silently/node
```
