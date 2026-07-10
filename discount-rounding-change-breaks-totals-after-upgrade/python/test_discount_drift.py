from discount_rounding_drift import compute_discount_drift


def test_saleor_documented_example_is_drifted():
    # 12.5% off 13.00 was 1.62 under ROUND_DOWN, is 1.63 under ROUND_HALF_UP
    result = compute_discount_drift(
        undiscounted_amount=13.00,
        discount_value_type="PERCENTAGE",
        discount_value=12.5,
        persisted_discount_amount=1.62,
    )
    assert result["expected_discount_amount"] == 1.63
    assert round(result["delta"], 2) == 0.01
    assert result["is_drifted"] is True


def test_matches_when_already_recomputed():
    result = compute_discount_drift(
        undiscounted_amount=13.00,
        discount_value_type="PERCENTAGE",
        discount_value=12.5,
        persisted_discount_amount=1.63,
    )
    assert result["is_drifted"] is False
    assert round(result["delta"], 2) == 0.0


def test_fixed_voucher_is_never_drifted():
    result = compute_discount_drift(
        undiscounted_amount=13.00,
        discount_value_type="FIXED",
        discount_value=5.00,
        persisted_discount_amount=999.99,  # deliberately wrong, still ignored
    )
    assert result["is_drifted"] is False


def test_clean_percentage_with_no_rounding_edge_is_not_drifted():
    result = compute_discount_drift(
        undiscounted_amount=20.00,
        discount_value_type="PERCENTAGE",
        discount_value=10,
        persisted_discount_amount=2.00,
    )
    assert result["is_drifted"] is False


def test_delta_direction_is_expected_minus_persisted():
    result = compute_discount_drift(
        undiscounted_amount=13.00,
        discount_value_type="PERCENTAGE",
        discount_value=12.5,
        persisted_discount_amount=1.70,  # persisted higher than expected
    )
    assert round(result["delta"], 2) == -0.07
    assert result["is_drifted"] is True


def test_drift_threshold_is_exactly_one_minor_unit():
    result = compute_discount_drift(
        undiscounted_amount=100.00,
        discount_value_type="PERCENTAGE",
        discount_value=10,
        persisted_discount_amount=9.99,
    )
    assert result["expected_discount_amount"] == 10.00
    assert result["is_drifted"] is True


def test_custom_currency_decimal_places_is_respected():
    result = compute_discount_drift(
        undiscounted_amount=13.00,
        discount_value_type="PERCENTAGE",
        discount_value=12.5,
        persisted_discount_amount=1.6,
        currency_decimal_places=1,
    )
    assert result["expected_discount_amount"] == 1.6
    assert result["is_drifted"] is False
