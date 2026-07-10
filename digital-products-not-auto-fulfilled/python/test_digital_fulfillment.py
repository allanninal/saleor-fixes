from flag_unfulfilled_digital_orders import should_auto_fulfill


def digital_line(**over):
    base = {
        "is_shipping_required": False,
        "digital_content": {"use_default_settings": True, "automatic_fulfillment": True},
        "has_stock": True,
    }
    base.update(over)
    return base


def order(**over):
    base = {
        "is_paid": True,
        "status": "UNFULFILLED",
        "paid_via": "CHECKOUT_CAPTURE",
        "lines": [digital_line()],
    }
    base.update(over)
    return base


def test_fully_eligible_case_is_true():
    assert should_auto_fulfill(order(), True) is True


def test_paid_via_mark_as_paid_is_false_even_with_flag_on():
    assert should_auto_fulfill(order(paid_via="MARK_AS_PAID"), True) is False


def test_missing_stock_is_false():
    o = order(lines=[digital_line(has_stock=False)])
    assert should_auto_fulfill(o, True) is False


def test_mixed_digital_and_physical_order_is_false():
    o = order(lines=[digital_line(), digital_line(is_shipping_required=True)])
    assert should_auto_fulfill(o, True) is False


def test_per_content_override_disabled_beats_shop_default_on():
    o = order(lines=[digital_line(digital_content={
        "use_default_settings": False, "automatic_fulfillment": False,
    })])
    assert should_auto_fulfill(o, True) is False


def test_per_content_override_enabled_beats_shop_default_off():
    o = order(lines=[digital_line(digital_content={
        "use_default_settings": False, "automatic_fulfillment": True,
    })])
    assert should_auto_fulfill(o, False) is True


def test_not_paid_is_false():
    assert should_auto_fulfill(order(is_paid=False), True) is False


def test_already_fulfilled_status_is_false():
    assert should_auto_fulfill(order(status="FULFILLED"), True) is False


def test_no_lines_is_false():
    assert should_auto_fulfill(order(lines=[]), True) is False


def test_missing_digital_content_is_false():
    o = order(lines=[digital_line(digital_content=None)])
    assert should_auto_fulfill(o, True) is False


def test_partially_fulfilled_status_is_eligible():
    assert should_auto_fulfill(order(status="PARTIALLY_FULFILLED"), True) is True
