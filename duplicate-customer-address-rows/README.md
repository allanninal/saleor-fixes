# Duplicate customer address rows created instead of reusing saved address

Every Saleor order with a shipping address stores that address as a new row on the customer's account. Saleor does not de-duplicate against the addresses the account already has, so a returning shopper who ships to the same place every time slowly accumulates identical address rows, one per order. The rows match on street, city, postal code, country, and name, but each is a separate row with its own opaque id, and the account address book fills up with copies.

This script pages through `customers` and their `addresses`, groups each customer's addresses by a normalized key with a pure function, keeps one address per cluster (the default shipping address when present, otherwise the first), and reports the ids of the rest as duplicates. Deleting is the risky part, so it defaults to a report and only calls `addressDelete` when you opt in.

**Full guide with diagrams:** https://www.allanninal.dev/saleor/duplicate-customer-address-rows/

## Run it

```bash
export SALEOR_API_URL="https://store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your-app-or-staff-token"
export DRY_RUN="true"

python duplicate-customer-address-rows/python/find_duplicate_customer_addresses.py
node   duplicate-customer-address-rows/node/find-duplicate-customer-addresses.js
```

`find_duplicate_addresses` (Python) / `findDuplicateAddresses` (Node) is a pure function: it groups a customer's addresses by a normalized key built from `firstName`, `lastName`, `streetAddress1`, `streetAddress2`, `city`, `postalCode`, and `country.code`, then returns one cluster per group with more than one match. Each cluster names the address to keep and the duplicate ids to merge away. Under `DRY_RUN=true` (the default) the script only logs the clusters; under `DRY_RUN=false` it calls `addressDelete` on each duplicate id. Deletes are irreversible, so review the report before ever running with `DRY_RUN=false`.

## Test

```bash
pytest duplicate-customer-address-rows/python
node --test duplicate-customer-address-rows/node
```
