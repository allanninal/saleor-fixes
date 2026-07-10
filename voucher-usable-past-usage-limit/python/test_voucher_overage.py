from detect_voucher_overage import detect_voucher_overage

V1 = "gid://saleor/Voucher/1"


def voucher(**over):
    base = {"id": V1, "code": "SALE50", "usageLimit": 50, "used": 50}
    base.update(over)
    return base


def order(order_id, voucher_id=V1, status="FULFILLED"):
    return {"id": order_id, "voucherId": voucher_id, "status": status}


def test_no_limit_returns_none():
    v = voucher(usageLimit=None)
    assert detect_voucher_overage(v, []) is None


def test_under_limit_returns_none():
    orders = [order(f"o{i}") for i in range(10)]
    v = voucher(usageLimit=50, used=10)
    assert detect_voucher_overage(v, orders) is None


def test_exactly_at_limit_returns_none():
    orders = [order(f"o{i}") for i in range(50)]
    v = voucher(usageLimit=50, used=50)
    assert detect_voucher_overage(v, orders) is None


def test_one_order_over_limit_is_flagged():
    orders = [order(f"o{i}") for i in range(51)]
    v = voucher(usageLimit=50, used=51)
    result = detect_voucher_overage(v, orders)
    assert result["overageCount"] == 1
    assert result["actualRedemptions"] == 51
    assert len(result["affectedOrderIds"]) == 51


def test_retried_payment_double_count_flagged_even_if_orders_match_limit():
    # used is already inflated by a retried checkoutComplete, but the real
    # order count is still at the limit. Flag on Saleor's own used disagreeing.
    orders = [order(f"o{i}") for i in range(50)]
    v = voucher(usageLimit=50, used=52)
    result = detect_voucher_overage(v, orders)
    assert result is not None
    assert result["overageCount"] == 0
    assert result["actualRedemptions"] == 50


def test_canceled_orders_excluded_from_count():
    orders = [order(f"o{i}") for i in range(50)] + [
        order("o-canceled-1", status="CANCELED"),
        order("o-canceled-2", status="CANCELED"),
        order("o-draft-1", status="DRAFT"),
    ]
    v = voucher(usageLimit=50, used=50)
    assert detect_voucher_overage(v, orders) is None


def test_orders_for_other_vouchers_are_ignored():
    orders = [order(f"o{i}") for i in range(30)] + [
        order("other-1", voucher_id="gid://saleor/Voucher/999"),
        order("other-2", voucher_id="gid://saleor/Voucher/999"),
    ]
    v = voucher(usageLimit=50, used=30)
    assert detect_voucher_overage(v, orders) is None


def test_overage_count_never_negative_when_used_inflated_but_orders_low():
    # used disagrees upward, but actual redemptions are well under the limit.
    orders = [order(f"o{i}") for i in range(5)]
    v = voucher(usageLimit=50, used=51)
    result = detect_voucher_overage(v, orders)
    assert result is not None
    assert result["overageCount"] == 0
    assert result["actualRedemptions"] == 5


def test_affected_order_ids_match_counted_orders_only():
    orders = [order(f"o{i}") for i in range(51)] + [order("draft-1", status="DRAFT")]
    v = voucher(usageLimit=50, used=51)
    result = detect_voucher_overage(v, orders)
    assert "draft-1" not in result["affectedOrderIds"]
    assert len(result["affectedOrderIds"]) == 51
