from detect_stock_webhook_desync import classify_stock_desync


def record(**over):
    base = {
        "variantId": "gid://saleor/ProductVariant/1",
        "warehouseId": "gid://saleor/Warehouse/1",
        "quantityBefore": 20,
        "quantityAfter": 15,
        "matchingDeliveryFound": False,
        "recentMutationHint": "UNKNOWN",
    }
    base.update(over)
    return base


def test_no_desync_when_quantity_unchanged():
    result = classify_stock_desync(record(quantityBefore=10, quantityAfter=10))
    assert result == {"isDesynced": False, "severity": "none", "reason": "no change"}


def test_no_desync_when_delivery_found():
    result = classify_stock_desync(record(matchingDeliveryFound=True))
    assert result == {"isDesynced": False, "severity": "none", "reason": "webhook delivered"}


def test_critical_when_order_fulfill_hint():
    result = classify_stock_desync(record(recentMutationHint="ORDER_FULFILL"))
    assert result["isDesynced"] is True
    assert result["severity"] == "critical"


def test_critical_when_order_cancel_hint():
    result = classify_stock_desync(record(recentMutationHint="ORDER_CANCEL"))
    assert result["severity"] == "critical"


def test_critical_when_crosses_zero():
    result = classify_stock_desync(record(quantityBefore=0, quantityAfter=5, recentMutationHint="UNKNOWN"))
    assert result["severity"] == "critical"


def test_critical_when_large_delta():
    result = classify_stock_desync(record(quantityBefore=100, quantityAfter=85, recentMutationHint="UNKNOWN"))
    assert result["severity"] == "critical"


def test_warn_when_small_unknown_delta():
    result = classify_stock_desync(record(quantityBefore=100, quantityAfter=99, recentMutationHint="UNKNOWN"))
    assert result == {
        "isDesynced": True,
        "severity": "warn",
        "reason": "suspected UNKNOWN, delta -1 with no matching PRODUCT_VARIANT_STOCK_UPDATED delivery",
    }


def test_no_desync_when_quantity_unchanged_even_with_hint():
    result = classify_stock_desync(record(quantityBefore=5, quantityAfter=5, recentMutationHint="ORDER_FULFILL"))
    assert result["isDesynced"] is False


def test_delivery_found_wins_over_critical_hint():
    result = classify_stock_desync(record(matchingDeliveryFound=True, recentMutationHint="ORDER_FULFILL"))
    assert result["isDesynced"] is False
