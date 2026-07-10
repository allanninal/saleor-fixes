# Voucher usage count double incremented on payment retries

Saleor increments voucher usage synchronously inside `checkoutComplete`. A two-stage "action required" payment gateway completes the same checkout by calling `checkoutComplete` twice, once when the gateway returns `confirmationNeeded` and again after the customer confirms and the payment actually captures. Both calls increment the counter, so `VoucherCode.used` ends up permanently inflated relative to the orders that actually used the code.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/voucher-usage-double-incremented/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export SALEOR_VOUCHER_ID="Vm91Y2hlcjox"
export DRY_RUN="true"

python voucher-usage-double-incremented/python/reconcile_voucher_usage.py
node   voucher-usage-double-incremented/node/reconcile-voucher-usage.js
```

`decide_voucher_usage_correction` is a pure function: it takes a voucher code's stored `used` counter and the list of orders that qualify for that code, and recomputes real usage from orders that are paid or reached `FULFILLED` / `PARTIALLY_FULFILLED` / `UNFULFILLED`. If stored usage is at or below real usage it returns `action: "none"`. If stored usage is higher, it returns `action: "decrement"` with the corrected value and the delta.

This script never writes the usage counter. Saleor does not expose a public `voucherCodeUsageSet` mutation, so the only safe lever without a custom app is to report the overcounted codes for staff to correct in the dashboard. Start with `DRY_RUN=true` (the default) to review the report first.

## Test

```bash
pytest voucher-usage-double-incremented/python
node --test voucher-usage-double-incremented/node
```
