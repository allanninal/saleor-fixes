"""Find duplicate address rows saved on Saleor customer accounts.

Every Saleor order with a shipping address stores that address as a new row on
the customer's account. Saleor does not de-duplicate against the addresses the
account already has, so a returning shopper who ships to the same place every
time slowly accumulates identical address rows, one per order. The addresses
match on street, city, postal code, country, and name, but each is a separate
row with its own opaque id, and the account address book fills up with copies.

This script pages through customers and their addresses, and a pure function
groups each customer's addresses by a normalized key. Any group with more than
one address is a duplicate cluster. The function keeps one address per cluster,
preferring the default shipping address, and returns the ids of the rest as the
duplicates to merge, so a human can review or an operator can delete them.

Deleting is the risky part, so DRY_RUN defaults to true and the script only
reports the duplicate ids it found. Set DRY_RUN=false to actually call
addressDelete on the extra rows. Run on a schedule. Safe to run again and
again in report mode.

Guide: https://www.allanninal.dev/saleor/duplicate-customer-address-rows/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_customer_addresses")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CUSTOMERS_QUERY = """
query($cursor: String) {
  customers(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        email
        addresses {
          id
          firstName
          lastName
          streetAddress1
          streetAddress2
          city
          postalCode
          country { code }
          isDefaultShippingAddress
        }
      }
    }
  }
}"""

ADDRESS_DELETE = """
mutation($id: ID!) {
  addressDelete(id: $id) {
    errors { field message }
  }
}"""


def gql(query, variables=None):
    r = requests.post(
        API_URL,
        json={"query": query, "variables": variables or {}},
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise RuntimeError(body["errors"])
    return body["data"]


def _norm(value):
    return " ".join((value or "").strip().lower().split())


def address_key(address):
    """Build a normalized identity key for an address. Pure, no I/O.

    Two addresses that share the same street, city, postal code, country, and
    name are considered the same physical address regardless of casing or
    stray whitespace.
    """
    country = address.get("country") or {}
    return (
        _norm(address.get("firstName")),
        _norm(address.get("lastName")),
        _norm(address.get("streetAddress1")),
        _norm(address.get("streetAddress2")),
        _norm(address.get("city")),
        _norm(address.get("postalCode")),
        _norm(country.get("code")),
    )


def find_duplicate_addresses(customers):
    """Pure decision function. No I/O.

    customers: list of {id, email, addresses: [ {id, firstName, lastName,
        streetAddress1, streetAddress2, city, postalCode,
        country: {code}, isDefaultShippingAddress} ]}
    returns: list of {customerId, email, key, keepId, duplicateIds}, one per
        cluster that has more than one matching address. keepId is the address
        to keep (the default shipping one if present, else the first seen),
        and duplicateIds are the extra rows that could be merged away.
    """
    results = []
    for customer in customers:
        groups = {}
        for address in customer.get("addresses") or []:
            key = address_key(address)
            groups.setdefault(key, []).append(address)

        for key, group in groups.items():
            if len(group) < 2:
                continue
            keep = next(
                (a for a in group if a.get("isDefaultShippingAddress")),
                group[0],
            )
            duplicate_ids = [a["id"] for a in group if a["id"] != keep["id"]]
            if not duplicate_ids:
                continue
            results.append({
                "customerId": customer["id"],
                "email": customer.get("email"),
                "key": key,
                "keepId": keep["id"],
                "duplicateIds": duplicate_ids,
            })
    return results


def all_customers():
    cursor = None
    while True:
        data = gql(CUSTOMERS_QUERY, {"cursor": cursor})["customers"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def delete_address(address_id):
    data = gql(ADDRESS_DELETE, {"id": address_id})
    errors = data["addressDelete"]["errors"]
    if errors:
        raise RuntimeError(errors)


def run():
    customers = list(all_customers())

    clusters = find_duplicate_addresses(customers)

    total_dupes = 0
    for cluster in clusters:
        total_dupes += len(cluster["duplicateIds"])
        log.warning(
            "Duplicate addresses for %s: keep %s, %d duplicate(s) %s",
            cluster["email"],
            cluster["keepId"],
            len(cluster["duplicateIds"]),
            cluster["duplicateIds"],
        )

    if not DRY_RUN:
        for cluster in clusters:
            for address_id in cluster["duplicateIds"]:
                delete_address(address_id)
                log.info("Deleted duplicate address %s", address_id)

    log.info(
        "Done. %d cluster(s), %d duplicate address(es) found. %s",
        len(clusters),
        total_dupes,
        "Duplicates deleted." if not DRY_RUN else "Dry run, nothing deleted.",
    )


if __name__ == "__main__":
    run()
