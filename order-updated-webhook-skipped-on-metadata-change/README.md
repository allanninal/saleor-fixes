# ORDER_UPDATED webhook skipped on metadata change

Saleor intentionally separates a full order update from a metadata-only update. `updateMetadata` and `updatePrivateMetadata` on an Order only mark metadata fields dirty, and Saleor's webhook dispatch logic checks for substantive order-field changes before firing `ORDER_UPDATED`, a check a metadata-only write never satisfies. Saleor instead emits a distinct `ORDER_METADATA_UPDATED` async event for exactly this case, so an app that only subscribed to `ORDER_UPDATED` never learns the order changed.

This script lists every webhook's subscribed events and recently metadata-touched orders, then reports any webhook whose subscription is missing `ORDER_METADATA_UPDATED` (the real misconfiguration) and any order whose metadata write has no matching delivery despite a correct subscription (a real delivery failure). It only repairs the subscription itself, and only when a human turns off dry run.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/order-updated-webhook-skipped-on-metadata-change/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python order-updated-webhook-skipped-on-metadata-change/python/detect_metadata_webhook_gap.py
node   order-updated-webhook-skipped-on-metadata-change/node/detect-metadata-webhook-gap.js
```

`classify_metadata_webhook_gap` is a pure function: it returns `MISCONFIGURED_SUBSCRIPTION` when the webhook never subscribed to `ORDER_METADATA_UPDATED` (Saleor will never fire `ORDER_UPDATED` for a metadata-only write, so this is the actual bug to fix), `DELIVERY_MISSING` when the subscription is correct but no delivery landed at or after the write (a real delivery failure), or `OK` when a matching delivery exists. Only `MISCONFIGURED_SUBSCRIPTION` is auto-repaired with `webhookUpdate`, and only when `DRY_RUN=false`. `DELIVERY_MISSING` is always report-only, Saleor has no mutation to replay a past delivery. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-updated-webhook-skipped-on-metadata-change/python
node --test order-updated-webhook-skipped-on-metadata-change/node
```
