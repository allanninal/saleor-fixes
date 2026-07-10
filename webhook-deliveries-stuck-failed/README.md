# Webhook deliveries stuck failed past retry limit

Saleor's `send_webhook_request` Celery task (`saleor/plugins/webhook/tasks.py`) retries an async webhook delivery with `retry_backoff=10` and `retry_kwargs={"max_retries": 5}`, roughly 10 * 2^n seconds of delay across 5 attempts. Once the fifth retry also fails, Celery never reschedules the task again and the `EventDelivery` is persisted as FAILED for good, with nothing built in that comes back to resurrect it. This job lists each webhook's FAILED deliveries with their recent attempts, finds the ones that have exhausted 5 attempts and are old enough that Saleor's own backoff window has closed, and calls `eventDeliveryRetry` once for the ones whose failures look transient. Deliveries whose endpoint looks consistently dead are only reported, never retried.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/webhook-deliveries-stuck-failed/

## Run it

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export STALE_AFTER_MINUTES="60"
export DRY_RUN="true"

python webhook-deliveries-stuck-failed/python/retry_stale_failed_deliveries.py
node   webhook-deliveries-stuck-failed/node/retry-stale-failed-deliveries.js
```

`decide_stale_failed_retries` is a pure function: a FAILED delivery is only acted on once it has reached `maxRetries` (default 5, matching Saleor's Celery `max_retries`) attempts and its last attempt is older than `staleAfterMs` (default 1 hour, well past the roughly 320 second exponential backoff ceiling). Anything still within that window is skipped so the script never races Saleor's own retries. Past that point, a delivery whose last attempts all show a 5xx status or no response code is classified `FLAG_DEAD_ENDPOINT` and only reported, never retried. Everything else is classified `RETRY` and gets a single guarded call to `eventDeliveryRetry`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest webhook-deliveries-stuck-failed/python
node --test webhook-deliveries-stuck-failed/node
```
