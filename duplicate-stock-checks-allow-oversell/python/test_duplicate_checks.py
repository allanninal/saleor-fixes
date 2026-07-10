from find_oversold import find_oversold_lines


def order(order_id, sku="SKU-1", warehouse_id="wh-1", allocated_qty=1, status="UNFULFILLED"):
    return {
        "order_id": order_id,
        "status": status,
        "lines": [{"sku": sku, "warehouse_id": warehouse_id, "allocated_qty": allocated_qty}],
    }


def stock(sku="SKU-1", warehouse_id="wh-1", on_hand_qty=1, reported_allocated_qty=1):
    return {
        "sku": sku,
        "warehouse_id": warehouse_id,
        "on_hand_qty": on_hand_qty,
        "reported_allocated_qty": reported_allocated_qty,
    }


def test_flags_two_orders_that_claim_the_same_last_unit():
    orders = [order("order-A"), order("order-B")]
    stocks = [stock(on_hand_qty=1, reported_allocated_qty=1)]
    result = find_oversold_lines(orders, stocks)
    assert len(result) == 1
    row = result[0]
    assert row["sku"] == "SKU-1"
    assert row["warehouse_id"] == "wh-1"
    assert row["recomputed_allocated_qty"] == 2
    assert row["oversold_by"] == 1
    assert row["offending_order_ids"] == ["order-A", "order-B"]


def test_no_flag_when_allocated_matches_stock():
    orders = [order("order-A")]
    stocks = [stock(on_hand_qty=1, reported_allocated_qty=1)]
    assert find_oversold_lines(orders, stocks) == []


def test_cancelled_orders_are_excluded_from_recomputed_demand():
    orders = [order("order-A", status="CANCELLED"), order("order-B")]
    stocks = [stock(on_hand_qty=1, reported_allocated_qty=1)]
    assert find_oversold_lines(orders, stocks) == []


def test_flags_when_reported_allocated_disagrees_with_recomputed():
    orders = [order("order-A", allocated_qty=1)]
    stocks = [stock(on_hand_qty=5, reported_allocated_qty=3)]
    result = find_oversold_lines(orders, stocks)
    assert len(result) == 1
    assert result[0]["reported_allocated_qty"] == 3
    assert result[0]["recomputed_allocated_qty"] == 1
    assert result[0]["oversold_by"] == 0


def test_separate_warehouses_are_not_confused():
    orders = [order("order-A", warehouse_id="wh-1"), order("order-B", warehouse_id="wh-2")]
    stocks = [
        stock(warehouse_id="wh-1", on_hand_qty=1, reported_allocated_qty=1),
        stock(warehouse_id="wh-2", on_hand_qty=1, reported_allocated_qty=1),
    ]
    assert find_oversold_lines(orders, stocks) == []
