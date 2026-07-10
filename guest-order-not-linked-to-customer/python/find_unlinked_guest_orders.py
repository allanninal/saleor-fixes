"""Find Saleor orders placed as a guest whose userEmail matches a registered
customer's email, even though order.user is null.

Saleor links order.user to a User only when the checkout itself was performed
while logged in. The linkage happens in _process_user_data_for_order during
checkout completion, and it reads the checkout's user_id, not its email. A
guest checkout stores the buyer's email on order.userEmail but never gets a
user_id, so order.user stays null even when the email matches an existing
account, because Saleor deliberately never runs a post-hoc lookup against the
User table by email (see saleor/saleor discussion #8508, issue #432).

This script only ever reports. There is no first-class orderUpdate field for
reassigning a customer after the fact, and auto-linking by email alone would
let anyone claim another account's order history just by entering their email
at guest checkout. Under DRY_RUN=true (the default) it only logs the report.
When DRY_RUN=false it additionally writes a CSV report file for staff review.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/guest-order-not-linked-to-customer/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_unlinked_guest_orders")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy-token")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPORT_PATH = os.environ.get("REPORT_PATH", "unlinked_guest_orders.csv")

ORDERS_QUERY = """
query($cursor: String) {
  orders(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { id number userEmail user { id } } }
  }
}"""

CUSTOMERS_QUERY = """
query($cursor: String) {
  customers(first: 50, after: $cursor, filter: {}) {
    pageInfo { hasNextPage endCursor }
    edges { node { id email } }
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


def _norm(email):
    return (email or "").strip().lower()


def find_unlinked_guest_orders(orders, customers):
    """Pure decision function. No I/O.

    orders: list of {id, number, userEmail, user: {id} | None}
    customers: list of {id, email}
    returns: list of {orderId, orderNumber, userEmail, matchedCustomerId}
    """
    by_email = {}
    for customer in customers:
        key = _norm(customer.get("email"))
        if key:
            by_email[key] = customer["id"]

    flagged = []
    for order in orders:
        if order.get("user") is not None:
            continue
        email = _norm(order.get("userEmail"))
        if not email:
            continue
        matched_id = by_email.get(email)
        if not matched_id:
            continue
        flagged.append({
            "orderId": order["id"],
            "orderNumber": order["number"],
            "userEmail": order["userEmail"],
            "matchedCustomerId": matched_id,
        })
    return flagged


def all_orders():
    cursor = None
    while True:
        data = gql(ORDERS_QUERY, {"cursor": cursor})["orders"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def all_customers():
    cursor = None
    while True:
        data = gql(CUSTOMERS_QUERY, {"cursor": cursor})["customers"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def to_plain_order(node):
    return {
        "id": node["id"],
        "number": node["number"],
        "userEmail": node.get("userEmail"),
        "user": node.get("user"),
    }


def write_report_csv(path, flagged_rows):
    fieldnames = ["orderId", "orderNumber", "userEmail", "matchedCustomerId"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in flagged_rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})


def run():
    orders = [to_plain_order(node) for node in all_orders()]
    customers = list(all_customers())

    flagged = find_unlinked_guest_orders(orders, customers)

    for row in flagged:
        log.warning("Unlinked guest order found for staff review: %s", row)

    if not DRY_RUN:
        write_report_csv(REPORT_PATH, flagged)
        log.info("Report written to %s", REPORT_PATH)

    log.info(
        "Done. %d unlinked guest order(s) found. %s",
        len(flagged),
        "Report file written." if not DRY_RUN else "Dry run, no file written.",
    )


if __name__ == "__main__":
    run()
