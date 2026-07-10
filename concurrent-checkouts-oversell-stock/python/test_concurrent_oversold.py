from find_oversold_stock import find_oversold_stocks


def stock(**over):
    base = {
        "variantId": "gid://saleor/ProductVariant/1",
        "sku": "SKU-1",
        "warehouseId": "gid://saleor/Warehouse/1",
        "warehouseSlug": "main",
        "quantity": 1,
        "quantityAllocated": 1,
    }
    base.update(over)
    return base


def test_no_oversold_when_allocated_equals_quantity():
    assert find_oversold_stocks([stock()]) == []


def test_flags_oversold_when_allocated_exceeds_quantity():
    result = find_oversold_stocks([stock(quantityAllocated=2)])
    assert result == [{
        "variantId": "gid://saleor/ProductVariant/1",
        "sku": "SKU-1",
        "warehouseId": "gid://saleor/Warehouse/1",
        "delta": 1,
    }]


def test_no_oversold_when_allocated_is_less_than_quantity():
    assert find_oversold_stocks([stock(quantity=5, quantityAllocated=3)]) == []


def test_sorted_by_delta_descending():
    rows = [
        stock(sku="SMALL", quantity=10, quantityAllocated=11),
        stock(sku="BIG", quantity=1, quantityAllocated=6),
    ]
    result = find_oversold_stocks(rows)
    assert [row["sku"] for row in result] == ["BIG", "SMALL"]


def test_only_oversold_rows_are_returned():
    rows = [
        stock(sku="OK", quantity=5, quantityAllocated=5),
        stock(sku="OVER", quantity=2, quantityAllocated=4),
    ]
    result = find_oversold_stocks(rows)
    assert len(result) == 1
    assert result[0]["sku"] == "OVER"
    assert result[0]["delta"] == 2


def test_zero_quantity_and_zero_allocated_is_not_oversold():
    assert find_oversold_stocks([stock(quantity=0, quantityAllocated=0)]) == []


def test_negative_delta_is_not_oversold():
    assert find_oversold_stocks([stock(quantity=100, quantityAllocated=1)]) == []
