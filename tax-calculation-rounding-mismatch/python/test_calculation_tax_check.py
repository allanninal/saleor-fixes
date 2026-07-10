from decimal import Decimal
from audit_tax_rounding import check_line_tax, reconcile_order


def test_exact_match_is_not_a_mismatch():
    is_mismatch, expected, delta = check_line_tax(
        total_net_amount=100.0, tax_rate=0.22, actual_tax_amount=22.0,
    )
    assert is_mismatch is False
    assert expected == Decimal("22.00")
    assert delta == Decimal("0.00")


def test_high_quantity_low_unit_price_drift_is_not_flagged_at_tolerance():
    # line.unitPrice is derived by dividing the already-rounded
    # line.totalPrice by quantity, so recomputing tax from unitPrice * qty
    # instead of from totalPrice.net directly can drift by several cents
    # for a high quantity, low unit price line. Here total_net=2.39 at
    # qty=96 gives a rounded unit price of 0.02, and 96 * 0.02 = 1.92, not
    # 2.39. Saleor's real tax is computed on totalPrice.net (2.39), giving
    # 0.53, versus a naive unitPrice*qty recomputation giving 0.42, an 11
    # cent gap that is exactly the kind of amplified per-unit rounding
    # remainder documented in saleor/saleor#6720. Checking against
    # totalPrice.net (the source of truth) instead of unitPrice * qty must
    # not flag this as a mismatch.
    total_net = 2.39
    actual_tax = 0.53  # round(total_net * 0.22, 2), Saleor's own computation
    is_mismatch, expected, delta = check_line_tax(
        total_net_amount=total_net, tax_rate=0.22,
        actual_tax_amount=actual_tax, tolerance_cents=1,
    )
    assert is_mismatch is False


def test_injected_corrupted_line_is_flagged():
    is_mismatch, expected, delta = check_line_tax(
        total_net_amount=100.0, tax_rate=0.22, actual_tax_amount=30.0,
    )
    assert is_mismatch is True
    assert expected == Decimal("22.00")
    assert delta == Decimal("8.00")


def test_one_cent_drift_within_tolerance_is_not_a_mismatch():
    is_mismatch, expected, delta = check_line_tax(
        total_net_amount=50.0, tax_rate=0.2, actual_tax_amount=10.01,
        tolerance_cents=1,
    )
    assert is_mismatch is False


def test_two_cent_drift_beyond_tolerance_is_flagged():
    is_mismatch, expected, delta = check_line_tax(
        total_net_amount=50.0, tax_rate=0.2, actual_tax_amount=10.03,
        tolerance_cents=1,
    )
    assert is_mismatch is True
    assert delta == Decimal("0.03")


def test_reconcile_order_flags_real_aggregation_bug():
    order = {
        "id": "T3JkZXI6MQ==",
        "number": "1001",
        "total": {"tax": {"amount": 99.0}},
        "shippingPrice": {"tax": {"amount": 1.0}},
        "lines": [
            {
                "id": "T3JkZXJMaW5lOjE=", "quantity": 1, "taxRate": 0.2,
                "totalPrice": {"net": {"amount": 100.0}, "tax": {"amount": 20.0}},
            },
        ],
    }
    result = reconcile_order(order)
    assert result["aggregationBug"] is True
    assert result["expectedOrderTax"] == 21.0
    assert result["actualOrderTax"] == 99.0
    assert result["aggregationDelta"] == 78.0


def test_reconcile_order_ok_when_totals_match_saleor_own_sum():
    order = {
        "id": "T3JkZXI6Mg==",
        "number": "1002",
        "total": {"tax": {"amount": 21.0}},
        "shippingPrice": {"tax": {"amount": 1.0}},
        "lines": [
            {
                "id": "T3JkZXJMaW5lOjI=", "quantity": 1, "taxRate": 0.2,
                "totalPrice": {"net": {"amount": 100.0}, "tax": {"amount": 20.0}},
            },
        ],
    }
    result = reconcile_order(order)
    assert result["aggregationBug"] is False
    assert result["lineMismatches"] == []


def test_reconcile_order_flags_line_mismatch_but_no_aggregation_bug():
    order = {
        "id": "T3JkZXI6Mw==",
        "number": "1003",
        "total": {"tax": {"amount": 30.0}},
        "shippingPrice": {"tax": {"amount": 0.0}},
        "lines": [
            {
                "id": "T3JkZXJMaW5lOjM=", "quantity": 1, "taxRate": 0.2,
                # actual tax (30.0) is way off expected (20.0), a corrupted line,
                # but order.total.tax (30.0) does equal the sum of line tax (30.0)
                # plus shipping (0.0), so this is not an aggregation bug.
                "totalPrice": {"net": {"amount": 100.0}, "tax": {"amount": 30.0}},
            },
        ],
    }
    result = reconcile_order(order)
    assert result["aggregationBug"] is False
    assert len(result["lineMismatches"]) == 1
    assert result["lineMismatches"][0]["lineId"] == "T3JkZXJMaW5lOjM="
