from flag_balance_drift import classify_balance_drift


def test_ok_when_balance_matches_expected():
    result = classify_balance_drift(100.0, 100.0, 0.0, 0.0)
    assert result["status"] == "OK"
    assert result["driftedBy"] == 0


def test_ok_with_legitimate_partial_balance():
    # partial capture, nothing refunded, balance is genuinely nonzero
    result = classify_balance_drift(100.0, 60.0, 0.0, 40.0)
    assert result["status"] == "OK"


def test_drifted_when_partial_refund_leaves_charged_amount_stale():
    # refunded 30 but totalCaptured never stepped down, so reported balance is wrong
    result = classify_balance_drift(100.0, 100.0, 30.0, 0.0)
    assert result["status"] == "BALANCE_DRIFTED"
    assert result["expectedBalance"] == 30.0
    assert result["driftedBy"] == -30.0


def test_drifted_when_authorization_adjustment_has_no_capture():
    # reported balance overstates what is actually owed after an adjustment
    result = classify_balance_drift(200.0, 150.0, 0.0, 75.0)
    assert result["status"] == "BALANCE_DRIFTED"
    assert result["expectedBalance"] == 50.0
    assert result["driftedBy"] == 25.0


def test_floating_point_rounding_within_epsilon_is_ok():
    result = classify_balance_drift(99.995, 100.0, 0.0, 0.0)
    assert result["status"] == "OK"


def test_drifted_by_is_signed_and_reports_direction():
    over_reported = classify_balance_drift(100.0, 100.0, 0.0, 10.0)
    under_reported = classify_balance_drift(100.0, 100.0, 0.0, -10.0)
    assert over_reported["driftedBy"] == 10.0
    assert under_reported["driftedBy"] == -10.0


def test_ok_when_fully_refunded_and_balance_equals_total():
    result = classify_balance_drift(100.0, 100.0, 100.0, 100.0)
    assert result["status"] == "OK"
