"""Find Saleor vouchers whose used count climbed past their usageLimit
under concurrent checkout completion.

Saleor increments a voucher's used counter only after checkout or order
completion, and the check that used is still below usageLimit is not
atomically guarded against a second completion doing the same read at
nearly the same instant. Under concurrent completion, two checkouts can
both pass the check before either write lands, pushing used above
usageLimit (saleor/saleor#544). A retried checkoutComplete across a 3DS
payment confirmation can also double count one redemption
(saleor/saleor#8219).

Rolling back a completed, paid order to unwind an over-redeemed voucher is
a business decision, so this script never cancels or refunds an order on
its own. Under DRY_RUN=true (the default) it only reports every overage:
the voucher, both counts, and the affected order ids. When DRY_RUN=false
the only automated repair is to stop new redemptions by setting the
voucher's endDate to now. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/voucher-usable-past-usage-limit/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_voucher_overage")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EXCLUDED_STATUSES = {"DRAFT", "CANCELED"}

VOUCHERS_QUERY = """
query($cursor: String) {
  vouchers(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node { id code usageLimit used singleUse applyOncePerCustomer }
    }
  }
}"""

ORDERS_BY_VOUCHER_QUERY = """
query($voucherCode: String!, $cursor: String) {
  orders(first: 50, after: $cursor, filter: { voucherCode: $voucherCode }) {
    pageInfo { hasNextPage endCursor }
    edges {
      node { id number created voucher { id } voucherCode status }
    }
  }
}"""

STOP_VOUCHER_MUTATION = """
mutation($id: ID!, $endDate: DateTime!) {
  voucherUpdate(id: $id, input: { endDate: $endDate }) {
    voucher { id endDate }
    errors { field message code }
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


def detect_voucher_overage(voucher, orders):
    """Pure decision function. No network or DB I/O.

    voucher: {id, code, usageLimit, used}
    orders: list of {id, voucherId, status}

    Returns None when there is nothing to flag, otherwise a report dict
    with voucherId, overageCount, actualRedemptions, and affectedOrderIds.
    """
    usage_limit = voucher.get("usageLimit")
    if usage_limit is None:
        return None

    counted = [
        o for o in orders
        if o.get("voucherId") == voucher.get("id") and o.get("status") not in EXCLUDED_STATUSES
    ]
    actual_redemptions = len(counted)
    overage_count = max(0, actual_redemptions - usage_limit)

    used = voucher.get("used", 0)
    if overage_count == 0 and used <= usage_limit:
        return None

    return {
        "voucherId": voucher["id"],
        "overageCount": overage_count,
        "actualRedemptions": actual_redemptions,
        "affectedOrderIds": [o["id"] for o in counted],
    }


def limited_vouchers():
    cursor = None
    while True:
        data = gql(VOUCHERS_QUERY, {"cursor": cursor})["vouchers"]
        for edge in data["edges"]:
            node = edge["node"]
            if node.get("usageLimit") is not None:
                yield node
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def orders_for_voucher(voucher_code):
    cursor = None
    while True:
        data = gql(ORDERS_BY_VOUCHER_QUERY, {"voucherCode": voucher_code, "cursor": cursor})["orders"]
        for edge in data["edges"]:
            node = edge["node"]
            yield {
                "id": node["id"],
                "voucherId": (node.get("voucher") or {}).get("id"),
                "status": node["status"],
            }
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def stop_further_redemptions(voucher_id):
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result = gql(STOP_VOUCHER_MUTATION, {"id": voucher_id, "endDate": now_iso})["voucherUpdate"]
    if result["errors"]:
        raise RuntimeError(result["errors"])


def run():
    reports = []
    for voucher in limited_vouchers():
        orders = list(orders_for_voucher(voucher["code"]))
        report = detect_voucher_overage(voucher, orders)
        if report is None:
            continue

        log.warning(
            "Overage: voucher=%s code=%s usageLimit=%s used=%s actualRedemptions=%s overageCount=%s orders=%s",
            report["voucherId"], voucher["code"], voucher["usageLimit"], voucher["used"],
            report["actualRedemptions"], report["overageCount"], report["affectedOrderIds"],
        )
        reports.append(report)

        if not DRY_RUN:
            log.info("Stopping further redemptions on voucher %s (%s).", report["voucherId"], voucher["code"])
            stop_further_redemptions(report["voucherId"])

    log.info(
        "Done. %d voucher(s) over their usage limit%s.",
        len(reports), "" if DRY_RUN else ", further redemptions stopped",
    )
    return reports


if __name__ == "__main__":
    run()
