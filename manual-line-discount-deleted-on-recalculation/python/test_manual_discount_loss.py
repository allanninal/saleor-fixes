from detect_discount_loss import decide_discount_loss


def before_line(**over):
    base = {
        "unitDiscountType": "FIXED",
        "unitDiscountValue": 5.0,
        "unitDiscountReason": "Loyalty discount",
        "unitPriceGrossAmount": 15.0,
    }
    base.update(over)
    return base


def after_line(**over):
    base = {
        "unitDiscountType": "FIXED",
        "unitDiscountValue": 5.0,
        "unitDiscountReason": "Loyalty discount",
        "unitPriceGrossAmount": 15.0,
        "undiscountedUnitPriceGrossAmount": 20.0,
    }
    base.update(over)
    return base


def test_no_loss_when_discount_unchanged():
    decision = decide_discount_loss(before_line(), after_line())
    assert decision == {"lost": False, "shouldFlag": False, "restoreInput": None}


def test_loss_when_value_and_reason_both_cleared():
    after = after_line(unitDiscountValue=0, unitDiscountReason=None, unitPriceGrossAmount=20.0)
    decision = decide_discount_loss(before_line(), after)
    assert decision["lost"] is True
    assert decision["shouldFlag"] is True
    assert decision["restoreInput"] == {
        "valueType": "FIXED",
        "value": 5.0,
        "reason": "Loyalty discount",
    }


def test_no_loss_when_line_never_had_a_manual_discount():
    before = before_line(unitDiscountValue=0, unitDiscountReason=None)
    after = after_line(unitDiscountValue=0, unitDiscountReason=None, unitPriceGrossAmount=20.0)
    decision = decide_discount_loss(before, after)
    assert decision["lost"] is False
    assert decision["restoreInput"] is None


def test_no_loss_when_value_present_but_reason_still_set():
    # after somehow still has zero value but a reason survives: treat as not
    # fully lost, since restoreInput logic requires both signals to be gone.
    after = after_line(unitDiscountValue=0, unitDiscountReason="Loyalty discount")
    decision = decide_discount_loss(before_line(), after)
    assert decision["lost"] is False


def test_no_loss_when_reason_cleared_but_value_survives():
    after = after_line(unitDiscountValue=5.0, unitDiscountReason=None)
    decision = decide_discount_loss(before_line(), after)
    assert decision["lost"] is False


def test_restore_input_uses_percentage_type_from_before():
    before = before_line(unitDiscountType="PERCENTAGE", unitDiscountValue=10.0)
    after = after_line(unitDiscountValue=0, unitDiscountReason=None, unitPriceGrossAmount=20.0)
    decision = decide_discount_loss(before, after)
    assert decision["restoreInput"]["valueType"] == "PERCENTAGE"
    assert decision["restoreInput"]["value"] == 10.0


def test_loss_detected_from_reason_alone_when_value_was_zero():
    # A merchant can apply a manual discount with a reason but a zero value
    # (e.g. documenting a price match at the same price). Losing the reason
    # alone still counts as losing the manual discount.
    before = before_line(unitDiscountValue=0, unitDiscountReason="Price match")
    after = after_line(unitDiscountValue=0, unitDiscountReason=None, unitPriceGrossAmount=15.0)
    decision = decide_discount_loss(before, after)
    assert decision["lost"] is True
    assert decision["restoreInput"] == {"valueType": "FIXED", "value": 0, "reason": "Price match"}
