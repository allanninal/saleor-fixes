from detect_dropped_voucher import diff_voucher_discount


def snapshot(**over):
    base = {"voucherCode": "SAVE10", "totalGross": 90.0, "undiscountedTotalGross": 100.0}
    base.update(over)
    return base


def test_voucher_preserved_is_not_flagged():
    draft = snapshot()
    completed = snapshot()
    result = diff_voucher_discount(draft, completed)
    assert result["isDropped"] is False
    assert result["delta"] == 0


def test_voucher_fully_dropped_is_flagged():
    draft = snapshot()
    completed = snapshot(voucherCode=None, totalGross=100.0)
    result = diff_voucher_discount(draft, completed)
    assert result["isDropped"] is True
    assert result["expectedDiscount"] == 10.0
    assert result["actualDiscount"] == 0.0


def test_voucher_partially_recalculated_smaller_is_flagged():
    draft = snapshot()
    completed = snapshot(totalGross=97.0)  # discount shrank from 10 to 3
    result = diff_voucher_discount(draft, completed)
    assert result["isDropped"] is True
    assert round(result["delta"], 2) == 7.0


def test_no_voucher_applied_on_draft_is_not_flagged():
    draft = snapshot(voucherCode=None, totalGross=100.0)
    completed = snapshot(voucherCode=None, totalGross=100.0)
    result = diff_voucher_discount(draft, completed)
    assert result["isDropped"] is False


def test_rounding_noise_under_tolerance_is_not_flagged():
    draft = snapshot()
    completed = snapshot(totalGross=90.005)  # 0.005 shift from tax rounding
    result = diff_voucher_discount(draft, completed, tolerance=0.01)
    assert result["isDropped"] is False
