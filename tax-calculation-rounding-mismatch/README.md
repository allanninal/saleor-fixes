# Tax calculation off by rounding cents on totals

With Saleor's flat-rate tax strategy, tax is computed and rounded to two decimal places independently on each order line, and those already-rounded per-line amounts are summed to produce `order.total` and `order.subtotal`, rather than summing exact unrounded values first and rounding once. Because `line.unitPrice` is derived by dividing the rounded `line.totalPrice` by quantity, high quantity or low unit price lines amplify the per-unit rounding remainder, so the sum of correctly rounded lines can legitimately differ from rate times subtotal by one or more cents. This is documented, longstanding Saleor behavior (see `saleor/saleor#6720`), not a bug.

This script audits orders against Saleor's own per-line rounding rule instead of a naive rate-times-subtotal recomputation, so it does not flag ordinary rounding drift as a false positive. It only reports. A genuine aggregation bug (`order.total.tax` disagreeing with the sum of a line's own already-rounded tax plus shipping tax) is a separate, rarer signal, and even then the only corrective action is a gated, no-op line update that forces Saleor to recompute totals server side, never a direct write to order amounts.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/tax-calculation-rounding-mismatch/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"
export AGGREGATION_FIX_THRESHOLD_CENTS="5"

python tax-calculation-rounding-mismatch/python/audit_tax_rounding.py
node   tax-calculation-rounding-mismatch/node/audit-tax-rounding.js
```

`check_line_tax` is a pure function: it recomputes a line's expected tax the way Saleor computes it (net total times tax rate, rounded to the currency's minor unit with round-half-up) and compares it to the actual tax with a tolerance sized in cents, so it does not flag Saleor's own expected per-line rounding drift. `reconcile_order` builds on it and separately checks whether `order.total.tax` matches the sum of every line's own already-rounded tax plus shipping tax, which is the real aggregation-bug signal. The only write, `orderLineUpdate` with the same quantity, is a forced recompute, gated behind `DRY_RUN=false` and a small confirmed delta. Start with `DRY_RUN=true` to review the reconciliation report first.

## Test

```bash
pytest tax-calculation-rounding-mismatch/python
node --test tax-calculation-rounding-mismatch/node
```
