from flag_entire_order_voucher_mismatch import (
    compute_expected_entire_order_percentage_discount,
    actual_voucher_discount,
    has_stacked_promotion_and_voucher,
    flag_order,
)


def test_simple_percentage_off_subtotal():
    # 100 subtotal, 10% voucher, no promotion involved
    assert compute_expected_entire_order_percentage_discount(100.0, 10, False) == 10.0


def test_issue_17453_scenario_is_non_zero():
    # 10 units at 10 each = 100 undiscounted, a 40% catalogue promotion already
    # brought the subtotal down to 60, then a 70% entire order voucher applies
    # to that already-discounted subtotal, not to the original 100.
    subtotal_after_promotion = 60.0
    expected = compute_expected_entire_order_percentage_discount(subtotal_after_promotion, 70, False)
    assert expected == 42.0
    assert expected != 0.0


def test_discount_never_exceeds_subtotal():
    assert compute_expected_entire_order_percentage_discount(50.0, 150, False) == 50.0


def test_apply_once_per_order_uses_cheapest_unit():
    expected = compute_expected_entire_order_percentage_discount(
        100.0, 20, True, cheapest_line_unit_price=15.0
    )
    assert expected == 3.0


def test_apply_once_per_order_with_no_cheapest_price_is_zero():
    expected = compute_expected_entire_order_percentage_discount(100.0, 20, True)
    assert expected == 0.0


def order(**over):
    base = {
        "id": "T3JkZXI6MQ==",
        "number": "1001",
        "subtotal": {"gross": {"amount": 60.0}},
        "undiscountedTotal": {"gross": {"amount": 100.0}},
        "total": {"gross": {"amount": 60.0}},
        "channel": {"slug": "default-channel"},
        "voucher": {
            "id": "Vm91Y2hlcjox",
            "type": "ENTIRE_ORDER",
            "discountValueType": "PERCENTAGE",
            "channelListings": [{"channel": {"slug": "default-channel"}, "discountValue": 70}],
        },
        "discounts": [{"type": "VOUCHER", "value": 70, "valueType": "PERCENTAGE", "amount": {"amount": 42.0}}],
        "lines": [{"id": "TGluZTox", "unitDiscountAmount": 4.0, "unitDiscountType": "PERCENTAGE",
                    "undiscountedUnitPrice": {"gross": {"amount": 10.0}}}],
    }
    base.update(over)
    return base


def test_matching_order_is_not_flagged():
    assert flag_order(order()) is None


def test_mismatched_order_is_flagged_with_details():
    bad = order(discounts=[{"type": "VOUCHER", "value": 70, "valueType": "PERCENTAGE", "amount": {"amount": 70.0}}])
    finding = flag_order(bad)
    assert finding is not None
    assert finding["order_number"] == "1001"
    assert finding["expected_discount"] == 42.0
    assert finding["actual_discount"] == 70.0
    assert round(finding["delta"], 2) == 28.0
    assert finding["stacked_with_promotion"] is True


def test_no_matching_channel_listing_is_skipped():
    o = order(channel={"slug": "other-channel"})
    assert flag_order(o) is None


def test_actual_voucher_discount_falls_back_to_total_gap():
    o = order(discounts=[])
    assert actual_voucher_discount(o) == 40.0


def test_has_stacked_promotion_and_voucher_detects_line_discount():
    assert has_stacked_promotion_and_voucher(order()) is True
    assert has_stacked_promotion_and_voucher(order(lines=[])) is False


def test_delta_within_tolerance_is_not_flagged():
    # actual discount off by less than a cent should not be flagged
    close_enough = order(discounts=[{"type": "VOUCHER", "value": 70, "valueType": "PERCENTAGE", "amount": {"amount": 42.005}}])
    assert flag_order(close_enough) is None
