from reconcile_voucher_usage import decide_voucher_usage_correction


def code(**over):
    base = {"id": "Vm91Y2hlckNvZGU6MQ==", "code": "SAVE10", "storedUsed": 2}
    base.update(over)
    return base


def order(**over):
    base = {"id": "T3JkZXI6MQ==", "status": "UNFULFILLED", "isPaid": True}
    base.update(over)
    return base


def test_decrement_when_double_incremented_by_retry():
    result = decide_voucher_usage_correction(code(storedUsed=2), [order()])
    assert result == {"action": "decrement", "correctedUsed": 1, "delta": 1}


def test_none_when_stored_matches_real_usage():
    result = decide_voucher_usage_correction(code(storedUsed=1), [order()])
    assert result == {"action": "none", "correctedUsed": 1, "delta": 0}


def test_none_when_stored_is_undercount():
    # out of scope for this repair, do not touch an undercount
    result = decide_voucher_usage_correction(code(storedUsed=1), [order(), order(id="T3JkZXI6Mg==")])
    assert result == {"action": "none", "correctedUsed": 1, "delta": 0}


def test_cancelled_orders_do_not_count_toward_real_usage():
    orders = [
        order(),
        order(id="T3JkZXI6Mg==", status="CANCELED", isPaid=False),
    ]
    result = decide_voucher_usage_correction(code(storedUsed=2), orders)
    assert result == {"action": "decrement", "correctedUsed": 1, "delta": 1}


def test_paid_but_status_not_yet_completed_still_counts():
    orders = [order(status="UNCONFIRMED", isPaid=True)]
    result = decide_voucher_usage_correction(code(storedUsed=2), orders)
    assert result == {"action": "decrement", "correctedUsed": 1, "delta": 1}


def test_zero_qualifying_orders_flags_full_stored_amount_as_delta():
    result = decide_voucher_usage_correction(code(storedUsed=3), [])
    assert result == {"action": "decrement", "correctedUsed": 0, "delta": 3}


def test_partially_fulfilled_counts_as_real_usage():
    orders = [order(status="PARTIALLY_FULFILLED", isPaid=False)]
    result = decide_voucher_usage_correction(code(storedUsed=1), orders)
    assert result == {"action": "none", "correctedUsed": 1, "delta": 0}


def test_no_qualifying_orders_and_zero_stored_is_none():
    result = decide_voucher_usage_correction(code(storedUsed=0), [])
    assert result == {"action": "none", "correctedUsed": 0, "delta": 0}
