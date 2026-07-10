from audit_subtotal_basis import decide_subtotal_mismatch


def order(**over):
    base = {
        "subtotalNet": 100.0,
        "subtotalGross": 122.0,
        "lines": [{"totalPriceNet": 100.0, "totalPriceGross": 122.0}],
    }
    base.update(over)
    return base


def test_net_expected_and_gross_recorded_is_a_mismatch():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": True}, recorded_subtotal=122.0)
    assert result["isMismatch"] is True
    assert result["expectedBasis"] == "net"
    assert result["expected"] == 100.0
    assert round(result["delta"], 2) == 22.0


def test_net_expected_and_net_recorded_is_not_a_mismatch():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": True}, recorded_subtotal=100.0)
    assert result["isMismatch"] is False


def test_gross_expected_and_net_recorded_is_a_mismatch():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": False}, recorded_subtotal=100.0)
    assert result["isMismatch"] is True
    assert result["expectedBasis"] == "gross"
    assert result["expected"] == 122.0


def test_gross_expected_and_gross_recorded_is_not_a_mismatch():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": False}, recorded_subtotal=122.0)
    assert result["isMismatch"] is False


def test_within_epsilon_is_not_a_mismatch():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": True}, recorded_subtotal=100.005, epsilon=0.01)
    assert result["isMismatch"] is False


def test_multi_line_order_sums_all_lines_for_expected():
    multi = order(lines=[
        {"totalPriceNet": 40.0, "totalPriceGross": 48.8},
        {"totalPriceNet": 60.0, "totalPriceGross": 73.2},
    ])
    result = decide_subtotal_mismatch(multi, {"pricesEnteredWithTax": True}, recorded_subtotal=100.0)
    assert result["isMismatch"] is False
    assert result["expected"] == 100.0


def test_zero_delta_is_never_a_mismatch_regardless_of_epsilon():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": True}, recorded_subtotal=100.0, epsilon=0.0)
    assert result["isMismatch"] is False
    assert result["delta"] == 0.0


def test_expected_basis_reported_matches_tax_config_gross():
    result = decide_subtotal_mismatch(order(), {"pricesEnteredWithTax": False}, recorded_subtotal=0.0)
    assert result["expectedBasis"] == "gross"
