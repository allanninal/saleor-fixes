# Order confirmation email sent before payment succeeds

Saleor's checkout flow calls `send_order_confirmation` synchronously right after `checkoutComplete` creates the order, which fires the order confirmation notification and logs the `PLACED` order event, regardless of whether the chosen payment or transaction has actually reached a captured or charge-success state. When a customer is redirected off-site to a payment provider and abandons or fails that payment, they still receive a confirmation email for an order sitting unconfirmed and unpaid. This job pages through orders, compares each one's `PLACED` event timestamp against its earliest successful charge event, flags the ones where the email fired with no successful charge behind it, and only cancels the ones that clear a grace window still unpaid.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/confirmation-email-sent-before-payment/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export CANCEL_GRACE_HOURS="24"
export DRY_RUN="true"

python confirmation-email-sent-before-payment/python/flag_confirmation_timing.py
node   confirmation-email-sent-before-payment/node/flag-confirmation-timing.js
```

`decide_confirmation_timing_issue` is a pure function (the current time is passed in): it returns `"ok"` whenever there was never a confirmation to worry about, the charge succeeded at or before the confirmation, or the order is paid through another path such as `orderMarkAsPaid`. It returns `"flag_email_premature"` when the confirmation fired with no successful charge yet and the order is still young, and `"flag_and_eligible_for_cancel"` once that same order clears `CANCEL_GRACE_HOURS`. The only write this script ever makes is `orderCancel`, and only for orders in the eligible-for-cancel state, and only with `DRY_RUN=false`. There is no supported mutation to un-send an email, so everything else is report-only. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest confirmation-email-sent-before-payment/python
node --test confirmation-email-sent-before-payment/node
```
