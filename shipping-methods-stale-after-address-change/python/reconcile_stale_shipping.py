"""Detect and reconcile Saleor checkouts with a stale shipping method after an address change.

checkoutShippingAddressUpdate invalidates Saleor's shipping caches on the server, but a
client that only fetched availableShippingMethods once, at checkoutCreate or in the same
response as the address mutation, never re-fetches, so the screen keeps showing the
pre-update list. This re-fetches the checkout fresh, decides with a pure function whether
the previously selected method is still valid, and only ever reselects a method under a
DRY_RUN guard, logging the {checkoutId, oldMethodId, newMethodId} pair first.

Guide: https://www.allanninal.dev/saleor/shipping-methods-stale-after-address-change/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_stale_shipping")

API_URL = os.environ.get("SALEOR_API_URL", "https://store.saleor.cloud/graphql/")
TOKEN = os.environ.get("SALEOR_AUTH_TOKEN", "dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STALE_TYPENAMES = {"CheckoutProblemDeliveryMethodStale", "CheckoutProblemDeliveryMethodInvalid"}

FRESH_CHECKOUT_QUERY = """
query($id: ID!) {
  checkout(id: $id) {
    shippingAddress { country { code } }
    availableShippingMethods { id name }
    shippingMethods { id name }
    problems {
      __typename
      ... on CheckoutProblemDeliveryMethodStale { __typename }
      ... on CheckoutProblemDeliveryMethodInvalid { __typename }
    }
    deliveryMethod { ... on ShippingMethod { id } }
  }
}"""

DELIVERY_METHOD_UPDATE = """
mutation($id: ID!, $methodId: ID) {
  checkoutDeliveryMethodUpdate(id: $id, deliveryMethodId: $methodId) {
    checkout { id deliveryMethod { ... on ShippingMethod { id } } }
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


def decide_stale_shipping(old_method_id, fresh_methods, problems):
    """Pure decision logic, no I/O.

    isStale is True when old_method_id is non-null and not present in the fresh
    methods list, or when problems includes CheckoutProblemDeliveryMethodStale or
    CheckoutProblemDeliveryMethodInvalid. replacementId is the first fresh method
    id when stale, or None if the fresh list is empty; otherwise it is old_method_id.
    """
    fresh_ids = [m["id"] for m in fresh_methods]
    has_stale_problem = any(p.get("__typename") in STALE_TYPENAMES for p in (problems or []))
    is_stale = (old_method_id is not None and old_method_id not in fresh_ids) or has_stale_problem
    if is_stale:
        replacement_id = fresh_ids[0] if fresh_ids else None
    else:
        replacement_id = old_method_id
    return {"isStale": is_stale, "replacementId": replacement_id}


def fetch_fresh_checkout(checkout_id):
    return gql(FRESH_CHECKOUT_QUERY, {"id": checkout_id})["checkout"]


def reselect_delivery_method(checkout_id, new_method_id):
    result = gql(DELIVERY_METHOD_UPDATE, {"id": checkout_id, "methodId": new_method_id})["checkoutDeliveryMethodUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])
    return result["checkout"]


def reconcile_checkout(checkout_id):
    checkout = fetch_fresh_checkout(checkout_id)
    old_method = checkout.get("deliveryMethod") or {}
    old_method_id = old_method.get("id")
    fresh_methods = checkout.get("availableShippingMethods") or []
    problems = checkout.get("problems") or []

    decision = decide_stale_shipping(old_method_id, fresh_methods, problems)
    if not decision["isStale"]:
        return False

    log.warning(
        "Checkout %s stale shipping method. old=%s new=%s %s",
        checkout_id, old_method_id, decision["replacementId"],
        "would reselect" if DRY_RUN else "reselecting",
    )
    if not DRY_RUN and decision["replacementId"] is not None:
        reselect_delivery_method(checkout_id, decision["replacementId"])
    return True


def run(checkout_ids):
    fixed = 0
    for checkout_id in checkout_ids:
        if reconcile_checkout(checkout_id):
            fixed += 1
    log.info("Done. %d checkout(s) %s.", fixed, "to reconcile" if DRY_RUN else "reconciled")


if __name__ == "__main__":
    ids = [cid for cid in os.environ.get("CHECKOUT_IDS", "").split(",") if cid]
    run(ids)
