"""Find Saleor bulk stock update rows that stayed stale or partial after
productVariantStocksUpdate or stockBulkUpdate ran.

Saleor's bulk stock mutations process a list of per-warehouse rows in one
call, but error handling is row-scoped via an errorPolicy. The default
REJECT_EVERYTHING rolls back the entire batch on any single bad row
(saleor/saleor#6479). REJECT_FAILED_ROWS and IGNORE_FAILED_ROWS instead
persist only the valid rows on purpose. A script that assumes the whole
batch always lands can end up with Stock rows still on their old quantity,
and concurrent writers can make a row look stale even after a real success
(saleor/saleor#5578).

This script never blind-writes over a mismatch. Under DRY_RUN=true (the
default) it only reports the reconciliation diff. When DRY_RUN=false it
re-issues a new, scoped stockBulkUpdate for just the rows whose mismatch a
genuine failed-row error explains, never the original batch, then re-reads
and re-diffs to confirm convergence. Safe to run again and again.

Guide: https://www.allanninal.dev/saleor/bulk-stock-update-leaves-stale-rows/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_bulk_stock")

API_URL = os.environ["SALEOR_API_URL"]
TOKEN = os.environ["SALEOR_AUTH_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REPAIRABLE_CODES = {"NOT_FOUND", "INVALID"}

VARIANT_STOCKS_QUERY = """
query($ids: [ID!]!) {
  productVariants(first: 100, filter: { ids: $ids }) {
    edges {
      node {
        id
        sku
        stocks { quantity quantityAllocated warehouse { id name } }
      }
    }
  }
}"""

STOCK_BULK_UPDATE = """
mutation($stocks: [StockBulkUpdateInput!]!) {
  stockBulkUpdate(stocks: $stocks, errorPolicy: REJECT_FAILED_ROWS) {
    results {
      stock { id quantity productVariant { id } warehouse { id } }
      errors { field message code }
    }
    count
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


def _key(variant_id, warehouse_id):
    return f"{variant_id}:{warehouse_id}"


def diff_stock_rows(intended, actual, mutation_errors):
    """Pure decision function. No I/O.

    intended: [{variantId, warehouseId, quantity}]
    actual: [{variantId, warehouseId, quantity}]
    mutation_errors: [{variantId, warehouseId, code}]

    Returns one entry per intended row:
    {variantId, warehouseId, intendedQuantity, actualQuantity, status}
    where status is one of "ok", "stale", "reported_error".
    """
    actual_by_key = {_key(r["variantId"], r["warehouseId"]): r["quantity"] for r in actual}
    error_keys = {_key(e.get("variantId"), e.get("warehouseId")) for e in mutation_errors}

    diffs = []
    for row in intended:
        key = _key(row["variantId"], row["warehouseId"])
        actual_quantity = actual_by_key.get(key)

        if key in error_keys:
            status = "reported_error"
        elif actual_quantity is None or actual_quantity != row["quantity"]:
            status = "stale"
        else:
            status = "ok"

        diffs.append({
            "variantId": row["variantId"],
            "warehouseId": row["warehouseId"],
            "intendedQuantity": row["quantity"],
            "actualQuantity": actual_quantity,
            "status": status,
        })
    return diffs


def actual_stock_rows(variant_ids):
    data = gql(VARIANT_STOCKS_QUERY, {"ids": variant_ids})["productVariants"]
    rows = []
    for edge in data["edges"]:
        node = edge["node"]
        for stock in node["stocks"]:
            rows.append({
                "variantId": node["id"],
                "sku": node["sku"],
                "warehouseId": stock["warehouse"]["id"],
                "quantity": stock["quantity"],
            })
    return rows


def run_bulk_update(rows):
    stocks_input = [
        {"variantId": r["variantId"], "warehouseId": r["warehouseId"], "quantity": r["quantity"]}
        for r in rows
    ]
    result = gql(STOCK_BULK_UPDATE, {"stocks": stocks_input})["stockBulkUpdate"]
    mutation_errors = []
    for i, row_result in enumerate(result["results"]):
        for err in (row_result.get("errors") or []):
            mutation_errors.append({
                "variantId": rows[i]["variantId"],
                "warehouseId": rows[i]["warehouseId"],
                "code": err["code"],
            })
    return mutation_errors


def run(intended_rows, mutation_errors=None):
    variant_ids = sorted({r["variantId"] for r in intended_rows})
    actual = actual_stock_rows(variant_ids)
    mutation_errors = mutation_errors or []

    diffs = diff_stock_rows(intended_rows, actual, mutation_errors)
    stale = [d for d in diffs if d["status"] == "stale"]

    for d in diffs:
        if d["status"] != "ok":
            log.warning(
                "%s variant=%s warehouse=%s intended=%d actual=%s",
                d["status"], d["variantId"], d["warehouseId"],
                d["intendedQuantity"], d["actualQuantity"],
            )

    repairable = [
        d for d in stale
        if any(e["code"] in REPAIRABLE_CODES
               for e in mutation_errors
               if e.get("variantId") == d["variantId"] and e.get("warehouseId") == d["warehouseId"])
    ]

    if not repairable:
        log.info("Done. %d stale row(s) reported, none auto-repairable.", len(stale))
        return diffs

    log.info("%d stale row(s) explained by a repairable error. %s",
              len(repairable), "would repair" if DRY_RUN else "repairing")

    if DRY_RUN:
        return diffs

    repair_rows = [
        {"variantId": d["variantId"], "warehouseId": d["warehouseId"], "quantity": d["intendedQuantity"]}
        for d in repairable
    ]
    run_bulk_update(repair_rows)

    confirm_actual = actual_stock_rows(variant_ids)
    confirm_diffs = diff_stock_rows(intended_rows, confirm_actual, [])
    still_stale = [d for d in confirm_diffs if d["status"] == "stale"]
    log.info("Repair done. %d row(s) still stale after re-diff.", len(still_stale))
    return confirm_diffs


if __name__ == "__main__":
    run([])
