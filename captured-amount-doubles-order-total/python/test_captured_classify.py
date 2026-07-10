from flag_over_captured import classify_order_capture


def tx(id_, amount, psp="psp_1"):
    return {"id": id_, "pspReference": psp, "chargedAmount": amount}


def test_ok_when_single_correct_capture():
    result = classify_order_capture(100.0, [tx("t1", 100.0)])
    assert result["status"] == "OK"
    assert result["overBy"] == 0
    assert result["culprits"] == []


def test_over_captured_when_two_full_amount_transactions():
    result = classify_order_capture(100.0, [tx("t1", 100.0, "psp_1"), tx("t2", 100.0, "psp_2")])
    assert result["status"] == "OVER_CAPTURED"
    assert result["totalCaptured"] == 200.0
    assert result["overBy"] == 100.0
    assert result["culprits"] == ["t1", "t2"]


def test_ok_with_partial_capture_and_refund_netting_to_total():
    # a partial capture plus a top-up that together equal the total, no doubling
    result = classify_order_capture(100.0, [tx("t1", 60.0), tx("t2", 40.0)])
    assert result["status"] == "OK"


def test_over_captured_with_partial_plus_full_duplicate():
    result = classify_order_capture(50.0, [tx("t1", 50.0, "psp_1"), tx("t2", 50.0, "psp_2")])
    assert result["status"] == "OVER_CAPTURED"
    assert result["overBy"] == 50.0
    assert result["culprits"] == ["t1", "t2"]


def test_floating_point_rounding_within_epsilon_is_ok():
    result = classify_order_capture(99.99, [tx("t1", 100.0)])
    assert result["status"] == "OK"


def test_culprits_sorted_by_charged_amount_descending():
    result = classify_order_capture(
        100.0,
        [tx("small", 5.0), tx("big1", 100.0, "psp_1"), tx("big2", 150.0, "psp_2")],
    )
    assert result["status"] == "OVER_CAPTURED"
    assert result["culprits"] == ["big2", "big1"]


def test_no_culprits_when_over_captured_from_many_small_transactions():
    # over total, but no single transaction reaches the full order amount on its own
    result = classify_order_capture(100.0, [tx("t1", 60.0), tx("t2", 60.0)])
    assert result["status"] == "OVER_CAPTURED"
    assert result["overBy"] == 20.0
    assert result["culprits"] == []
