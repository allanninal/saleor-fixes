# Webhook payload fields diverge from documented schema

Saleor supports two incompatible webhook payload mechanisms: a legacy hard-coded shape documented with a sample payload per event, and a subscription-defined shape set by the `query` field on `Webhook`, which delivers exactly whatever that GraphQL query selects. There is no fixed schema for a subscription webhook. Drift shows up when the query goes stale after a Saleor field is renamed, deprecated, or moved behind a new type, or when a delivery is compared against the generic legacy sample by mistake. Saleor never validates a delivered payload against the docs or the query at send time, so nothing errors. This job lists every webhook and its `subscriptionQuery`, extracts the fields it selects for each event type, fetches a recent delivery, parses the payload, and diffs it against the expected fields so a human can review the exact drift before touching the query.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/webhook-payload-diverges-from-schema/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"

# Optional: apply a human-reviewed corrected query to one webhook
export WEBHOOK_ID="gid://saleor/Webhook/1"
export NEW_SUBSCRIPTION_QUERY="subscription { event { ... on ProductUpdated { product { id name } } } }"

python webhook-payload-diverges-from-schema/python/detect_webhook_payload_drift.py
node   webhook-payload-diverges-from-schema/node/detect-webhook-payload-drift.js
```

`diff_payload_against_schema` is a pure function: it takes a parsed delivery payload and the flat list of field names the subscription query (or the documented legacy sample) expects, and returns `missingInPayload` (fields expected but absent or null) and `unexpectedInPayload` (fields present but never requested). No network or file I/O, so it is easy to unit test with fixture pairs for a renamed field, a deprecated field returning null, and an extra field a newer Saleor version added.

This script never rewrites a subscription query on its own, the app's own webhook handler code depends on the exact fields it currently requests. Under `DRY_RUN=true` (the default) it only reports drift per webhook: missing fields, unexpected fields, and a sample delivery id. When `DRY_RUN=false` and `WEBHOOK_ID` plus `NEW_SUBSCRIPTION_QUERY` are set to a query a human has reviewed, it prints the old versus new query and calls `webhookUpdate`. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest webhook-payload-diverges-from-schema/python
node --test webhook-payload-diverges-from-schema/node
```
