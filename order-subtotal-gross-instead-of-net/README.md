# Order subtotal uses gross instead of net price

Saleor's `Order.subtotal`, `Order.total`, and every `OrderLine.unitPrice` and `totalPrice` resolve to a `TaxedMoney` object that always carries both a `gross` amount and a `net` amount together, computed per line from the channel's `taxConfiguration` (`pricesEnteredWithTax`, `displayGrossPrices`, `chargeTaxes`) or a custom `ORDER_CALCULATE_TAXES` tax app webhook. The bug is not in Saleor's stored data, both figures it returns are correct, it is in a script, report, or migration that reads `subtotal.gross.amount` as the only subtotal while the channel's `pricesEnteredWithTax` convention and the downstream ledger expect net (or the reverse). This job pages through orders with their lines and channel tax configuration, recomputes the expected net and gross subtotal from the lines, compares it against the figure a downstream consumer recorded, and reports every mismatch with both amounts and the delta.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/order-subtotal-gross-instead-of-net/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export SUBTOTAL_EPSILON="0.01"
export DRY_RUN="true"

python order-subtotal-gross-instead-of-net/python/audit_subtotal_basis.py
node   order-subtotal-gross-instead-of-net/node/audit-subtotal-basis.js
```

`decide_subtotal_mismatch` is a pure function: it derives the expected basis from `taxConfig.pricesEnteredWithTax` (net when true, gross otherwise, per your store's policy), sums the lines' `totalPriceNet` or `totalPriceGross` to get the expected subtotal, and compares it against the recorded figure with a small rounding epsilon. The script only ever logs a report row. Saleor's own order record is never rewritten, since there is nothing corrupt inside Saleor to repair; only a confirmed, human-approved change to the downstream export or ledger resolves the mismatch.

## Test

```bash
pytest order-subtotal-gross-instead-of-net/python
node --test order-subtotal-gross-instead-of-net/node
```
