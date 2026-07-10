"""Flag Saleor checkouts that look like a stale, client side reused checkout
token rather than a fresh one from checkoutCreate.

Saleor 3.x always inserts a new Checkout row from checkoutCreate and never
auto-reuses one, so a stale checkout almost always means the storefront or app
kept replaying a saved token/id instead of asking for a new one.

Report only. Never edits a checkout or detaches a user. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/checkout-create-returns-stale-checkout/
"""
import os
import datetime
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stale_checkout")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
MAX_IDLE_HOURS = float(os.environ.get("MAX_IDLE_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CHECKOUTS_QUERY = """
query($cursor: String) {
  checkouts(first: 100, after: $cursor) {
    edges {
      node {
        id
        token
        created
        updatedAt
        user { id email }
        channel { slug }
        voucherCode
        discountName
        lines { id quantity variant { id product { id } } }
        metadata { key value }
        totalPrice { gross { amount currency } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}"""

VOUCHER_QUERY = """
query($code: String!) {
  vouchers(first: 1, filter: { search: $code }) {
    edges { node { code usageLimit used endDate } }
  }
}"""

VARIANT_LISTING_QUERY = """
query($id: ID!, $channel: String!) {
  productVariant(id: $id, channel: $channel) {
    id
    channelListings { channel { slug } }
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


def _to_epoch_ms(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def classify_stale_checkout(checkout, max_idle_ms):
    """
    Pure decision logic, no I/O. All data is pre-fetched.
    checkout: {
      "id": str, "token": str, "createdAt": str, "updatedAt": str,
      "userEmail": str | None, "channelSlug": str, "voucherCode": str | None,
      "lines": [{"variantId": str, "isChannelListed": bool}],
      "expectedSessionId": str | None, "storedSessionMeta": str | None,
      "voucherIsActive": bool | None, "now": str,
    }
    Returns {"stale": bool, "reasons": [str]}.
    """
    reasons = []

    expected = checkout.get("expectedSessionId")
    if expected is not None and expected != checkout.get("storedSessionMeta"):
        reasons.append("session_mismatch")

    voucher_code = checkout.get("voucherCode")
    if voucher_code is not None and checkout.get("voucherIsActive") is False:
        reasons.append("orphaned_voucher")

    lines = checkout.get("lines") or []
    if any(not line.get("isChannelListed", True) for line in lines):
        reasons.append("delisted_line")

    now_ms = _to_epoch_ms(checkout["now"])
    updated_ms = _to_epoch_ms(checkout["updatedAt"])
    if (now_ms - updated_ms) > max_idle_ms:
        reasons.append("long_idle")

    return {"stale": len(reasons) > 0, "reasons": reasons}


def voucher_is_active(code, now_iso):
    edges = gql(VOUCHER_QUERY, {"code": code})["vouchers"]["edges"]
    if not edges:
        return False
    node = edges[0]["node"]
    if node["endDate"] and node["endDate"] < now_iso:
        return False
    if node["usageLimit"] is not None and node["used"] >= node["usageLimit"]:
        return False
    return True


def variant_is_channel_listed(variant_id, channel_slug):
    data = gql(VARIANT_LISTING_QUERY, {"id": variant_id, "channel": channel_slug})
    variant = data.get("productVariant")
    if not variant:
        return False
    return bool(variant.get("channelListings"))


def open_checkouts():
    cursor = None
    while True:
        data = gql(CHECKOUTS_QUERY, {"cursor": cursor})["checkouts"]
        for edge in data["edges"]:
            yield edge["node"]
        if not data["pageInfo"]["hasNextPage"]:
            return
        cursor = data["pageInfo"]["endCursor"]


def _build_checkout_shape(node, now_iso):
    channel_slug = (node.get("channel") or {}).get("slug")
    voucher_code = node.get("voucherCode")
    voucher_active = None
    if voucher_code:
        voucher_active = voucher_is_active(voucher_code, now_iso)

    lines = []
    for line in node.get("lines") or []:
        variant = line.get("variant") or {}
        variant_id = variant.get("id")
        listed = True
        if variant_id and channel_slug:
            listed = variant_is_channel_listed(variant_id, channel_slug)
        lines.append({"variantId": variant_id, "isChannelListed": listed})

    metadata = {m["key"]: m["value"] for m in (node.get("metadata") or [])}

    return {
        "id": node["id"],
        "token": node["token"],
        "createdAt": node["created"],
        "updatedAt": node["updatedAt"],
        "userEmail": (node.get("user") or {}).get("email"),
        "channelSlug": channel_slug,
        "voucherCode": voucher_code,
        "lines": lines,
        "expectedSessionId": metadata.get("expected_session_id"),
        "storedSessionMeta": metadata.get("session_id"),
        "voucherIsActive": voucher_active,
        "now": now_iso,
    }


def run():
    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")
    max_idle_ms = MAX_IDLE_HOURS * 3600 * 1000
    mode = "dry run" if DRY_RUN else "live"
    log.info("Scanning open checkouts (%s, report only, max idle %.1fh)", mode, MAX_IDLE_HOURS)

    flagged = 0
    for node in open_checkouts():
        shape = _build_checkout_shape(node, now_iso)
        result = classify_stale_checkout(shape, max_idle_ms)
        if not result["stale"]:
            continue
        flagged += 1
        log.warning(
            "STALE checkout id=%s token=%s user=%s channel=%s reasons=%s",
            shape["id"], shape["token"], shape["userEmail"], shape["channelSlug"],
            ",".join(result["reasons"]),
        )
    log.info("Done. %d checkout(s) flagged. No checkouts were changed.", flagged)
    return flagged


if __name__ == "__main__":
    run()
