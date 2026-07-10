from flag_overcharged_orders import decide_overcharge_flag


def order(**over):
    base = {"totalGrossAmount": 100.0, "totalCharged": 100.0, "totalAuthorized": 0.0, "currency": "USD"}
    base.update(over)
    return base


def test_exact_match_is_not_overcharged():
    result = decide_overcharge_flag(order(), [{"chargedAmount": 100.0, "authorizedAmount": 0.0}])
    assert result["isOvercharged"] is False
    assert result["capturedPlusAuthorized"] == 100.0
    assert result["overageAmount"] == 0.0


def test_one_cent_over_is_overcharged():
    result = decide_overcharge_flag(order(), [{"chargedAmount": 100.01, "authorizedAmount": 0.0}])
    assert result["isOvercharged"] is True
    assert round(result["overageAmount"], 2) == 0.01


def test_within_epsilon_is_not_overcharged():
    result = decide_overcharge_flag(order(), [{"chargedAmount": 100.003, "authorizedAmount": 0.0}], epsilon=0.005)
    assert result["isOvercharged"] is False


def test_double_capture_is_overcharged():
    transactions = [
        {"chargedAmount": 100.0, "authorizedAmount": 0.0},
        {"chargedAmount": 100.0, "authorizedAmount": 0.0},
    ]
    result = decide_overcharge_flag(order(), transactions)
    assert result["isOvercharged"] is True
    assert result["capturedPlusAuthorized"] == 200.0
    assert round(result["overageAmount"], 2) == 100.0


def test_zero_total_with_any_charge_is_overcharged():
    result = decide_overcharge_flag(order(totalGrossAmount=0.0), [{"chargedAmount": 5.0, "authorizedAmount": 0.0}])
    assert result["isOvercharged"] is True


def test_falls_back_to_order_totals_when_no_transactions_array():
    result = decide_overcharge_flag(order(totalCharged=150.0, totalAuthorized=0.0), transactions=None)
    assert result["isOvercharged"] is True
    assert result["capturedPlusAuthorized"] == 150.0


def test_authorized_plus_charged_together_can_overcharge():
    transactions = [{"chargedAmount": 80.0, "authorizedAmount": 25.0}]
    result = decide_overcharge_flag(order(), transactions)
    assert result["isOvercharged"] is True
    assert result["capturedPlusAuthorized"] == 105.0


def test_zero_charge_and_zero_total_is_not_overcharged():
    result = decide_overcharge_flag(order(totalGrossAmount=0.0), [{"chargedAmount": 0.0, "authorizedAmount": 0.0}])
    assert result["isOvercharged"] is False
    assert result["overageAmount"] == 0.0


def test_empty_transactions_list_falls_back_to_order_totals():
    result = decide_overcharge_flag(order(totalCharged=100.0, totalAuthorized=10.0), [])
    assert result["isOvercharged"] is True
    assert result["capturedPlusAuthorized"] == 110.0
