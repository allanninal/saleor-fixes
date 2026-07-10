from reconcile_bulk_stock import diff_stock_rows

V1 = "gid://saleor/ProductVariant/1"
W1 = "gid://saleor/Warehouse/1"
W2 = "gid://saleor/Warehouse/2"


def test_ok_when_actual_matches_intended():
    intended = [{"variantId": V1, "warehouseId": W1, "quantity": 10}]
    actual = [{"variantId": V1, "warehouseId": W1, "quantity": 10}]
    result = diff_stock_rows(intended, actual, [])
    assert result == [{
        "variantId": V1, "warehouseId": W1,
        "intendedQuantity": 10, "actualQuantity": 10, "status": "ok",
    }]


def test_stale_when_actual_does_not_match():
    intended = [{"variantId": V1, "warehouseId": W1, "quantity": 10}]
    actual = [{"variantId": V1, "warehouseId": W1, "quantity": 4}]
    result = diff_stock_rows(intended, actual, [])
    assert result[0]["status"] == "stale"
    assert result[0]["actualQuantity"] == 4


def test_stale_when_actual_missing_entirely():
    intended = [{"variantId": V1, "warehouseId": W2, "quantity": 5}]
    result = diff_stock_rows(intended, [], [])
    assert result[0]["status"] == "stale"
    assert result[0]["actualQuantity"] is None


def test_reported_error_takes_priority_over_mismatch():
    intended = [{"variantId": V1, "warehouseId": W1, "quantity": 10}]
    actual = [{"variantId": V1, "warehouseId": W1, "quantity": 4}]
    errors = [{"variantId": V1, "warehouseId": W1, "code": "NOT_FOUND"}]
    result = diff_stock_rows(intended, actual, errors)
    assert result[0]["status"] == "reported_error"


def test_reported_error_even_when_actual_matches():
    intended = [{"variantId": V1, "warehouseId": W1, "quantity": 10}]
    actual = [{"variantId": V1, "warehouseId": W1, "quantity": 10}]
    errors = [{"variantId": V1, "warehouseId": W1, "code": "INVALID"}]
    result = diff_stock_rows(intended, actual, errors)
    assert result[0]["status"] == "reported_error"


def test_multiple_rows_get_independent_status():
    intended = [
        {"variantId": V1, "warehouseId": W1, "quantity": 10},
        {"variantId": V1, "warehouseId": W2, "quantity": 20},
    ]
    actual = [
        {"variantId": V1, "warehouseId": W1, "quantity": 10},
        {"variantId": V1, "warehouseId": W2, "quantity": 1},
    ]
    result = diff_stock_rows(intended, actual, [])
    statuses = {r["warehouseId"]: r["status"] for r in result}
    assert statuses[W1] == "ok"
    assert statuses[W2] == "stale"


def test_empty_intended_returns_empty_list():
    assert diff_stock_rows([], [], []) == []


def test_unrelated_mutation_error_does_not_affect_other_rows():
    intended = [
        {"variantId": V1, "warehouseId": W1, "quantity": 10},
        {"variantId": V1, "warehouseId": W2, "quantity": 20},
    ]
    actual = [
        {"variantId": V1, "warehouseId": W1, "quantity": 10},
        {"variantId": V1, "warehouseId": W2, "quantity": 20},
    ]
    errors = [{"variantId": V1, "warehouseId": W2, "code": "NOT_FOUND"}]
    result = diff_stock_rows(intended, actual, errors)
    statuses = {r["warehouseId"]: r["status"] for r in result}
    assert statuses[W1] == "ok"
    assert statuses[W2] == "reported_error"
