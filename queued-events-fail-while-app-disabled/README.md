# Queued events become permanently failed while app disabled

Saleor's webhook dispatcher checks `Webhook.isActive` and the parent `App.isActive` at the moment a queued event is popped off the Celery task queue, not at the moment it was enqueued. Disabling an app, whether by hand or through the circuit breaker after repeated delivery failures, does not pause the queue: any event already sitting there still gets picked up, sees the webhook or app inactive, and is written to `EventDelivery` with `status: FAILED`, a terminal state with no attempt made and no automatic retry. Re-enabling the app only resumes delivery for events enqueued after that point, so anything failed during the disabled window has to be found and retried manually before `EVENT_PAYLOAD_DELETE_PERIOD` (14 days by default) purges its payload.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/queued-events-fail-while-app-disabled/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token with MANAGE_APPS"
export APP_ID="gid://saleor/App/1"
export APP_DISABLED_AT="2026-06-25T09:00:00Z"
export APP_REENABLED_AT="2026-06-25T11:30:00Z"
export EVENT_PAYLOAD_RETENTION_DAYS="14"
export DRY_RUN="true"

python queued-events-fail-while-app-disabled/python/retry_dropped_events.py
node   queued-events-fail-while-app-disabled/node/retry-dropped-events.js
```

`classify_dropped_deliveries` is a pure function: a delivery is skipped unless its status is `FAILED` and its `createdAt` falls inside `[appDisabledAt, appReenabledAt ?? now]`. Inside that window, it is flagged `FLAG_UNRECOVERABLE` when the payload is null or older than the retention period, otherwise it is marked `RETRY`. There is no bulk-replay mutation in Saleor, so the script calls `eventDeliveryRetry` one delivery at a time. Under `DRY_RUN=true` (the default) it only logs what it would retry or flag. Start with `DRY_RUN=true` to review the list first, and treat anything flagged unrecoverable as work for a manual reconciliation script, not a retry.

## Test

```bash
pytest queued-events-fail-while-app-disabled/python
node --test queued-events-fail-while-app-disabled/node
```
