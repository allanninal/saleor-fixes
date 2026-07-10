from detect_stock_drift import detect_stock_drift


def stock(**over):
    base = {
        "variantId": "gid://saleor/ProductVariant/1",
        "sku": "SKU-1",
        "warehouseId": "gid://saleor/Warehouse/1",
        "quantity": 5,
        "quantityAllocated": 0,
    }
    base.update(over)
    return base


def test_no_drift_when_quantity_covers_allocations():
    result = detect_stock_drift(stock(), [{"quantity": 2}])
    assert result["isDrift"] is False


def test_drift_when_allocated_exceeds_quantity():
    result = detect_stock_drift(stock(quantity=1), [{"quantity": 3}])
    assert result == {"isDrift": True, "delta": 2, "reason": "allocated_exceeds_quantity"}


def test_drift_when_known_physical_count_exceeds_quantity():
    result = detect_stock_drift(stock(quantity=0), [], known_physical_count=12)
    assert result == {"isDrift": True, "delta": 12, "reason": "quantity_below_known_physical_count"}


def test_drift_when_zero_quantity_with_open_allocations():
    result = detect_stock_drift(stock(quantity=0), [{"quantity": 1}])
    assert result == {"isDrift": True, "delta": 1, "reason": "zero_quantity_with_open_allocations"}


def test_no_drift_when_zero_quantity_and_no_allocations():
    result = detect_stock_drift(stock(quantity=0), [])
    assert result["isDrift"] is False


def test_no_drift_when_known_physical_count_matches():
    result = detect_stock_drift(stock(quantity=5), [], known_physical_count=5)
    assert result["isDrift"] is False


def test_allocated_exceeds_quantity_takes_priority_over_known_count():
    # even if a lower known physical count would look consistent,
    # allocations exceeding quantity is flagged first
    result = detect_stock_drift(stock(quantity=2), [{"quantity": 5}], known_physical_count=2)
    assert result == {"isDrift": True, "delta": 3, "reason": "allocated_exceeds_quantity"}


def test_multiple_allocations_are_summed():
    result = detect_stock_drift(stock(quantity=1), [{"quantity": 1}, {"quantity": 1}])
    assert result == {"isDrift": True, "delta": 1, "reason": "allocated_exceeds_quantity"}
