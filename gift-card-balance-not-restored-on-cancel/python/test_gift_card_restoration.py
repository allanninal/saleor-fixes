from restore_gift_card_balance import plan_gift_card_restoration


def order(**over):
    base = {"id": "T3JkZXI6MQ==", "status": "CANCELED"}
    base.update(over)
    return base


def usage(**over):
    base = {
        "giftCardId": "R2lmdENhcmQ6MQ==",
        "currentBalanceAmount": 0.0,
        "initialBalanceAmount": 50.0,
        "usedInOrderId": "T3JkZXI6MQ==",
        "amountUsed": 50.0,
        "alreadyRestored": False,
    }
    base.update(over)
    return base


def test_restores_full_amount_when_not_already_restored():
    plans = plan_gift_card_restoration(order(), [usage()])
    assert plans == [{
        "giftCardId": "R2lmdENhcmQ6MQ==",
        "restoreToAmount": 50.0,
        "reason": "order_cancelled_gift_card_not_refunded",
    }]


def test_no_plan_when_order_not_cancelled():
    plans = plan_gift_card_restoration(order(status="FULFILLED"), [usage()])
    assert plans == []


def test_no_plan_when_already_restored():
    plans = plan_gift_card_restoration(order(), [usage(alreadyRestored=True)])
    assert plans == []


def test_no_plan_when_amount_used_is_zero():
    plans = plan_gift_card_restoration(order(), [usage(amountUsed=0)])
    assert plans == []


def test_no_plan_when_amount_used_is_negative():
    plans = plan_gift_card_restoration(order(), [usage(amountUsed=-5.0)])
    assert plans == []


def test_no_plan_for_usage_on_a_different_order():
    plans = plan_gift_card_restoration(order(), [usage(usedInOrderId="T3JkZXI6OTk=")])
    assert plans == []


def test_caps_at_initial_balance_within_epsilon():
    # partial current balance plus amount used lands exactly on initial balance
    plans = plan_gift_card_restoration(
        order(), [usage(currentBalanceAmount=10.0, amountUsed=40.0, initialBalanceAmount=50.0)]
    )
    assert plans[0]["restoreToAmount"] == 50.0


def test_flags_anomaly_instead_of_clamping_when_overshoot_is_large():
    # restoring would land at 70, well above the 50 initial balance: skip, do not clamp
    plans = plan_gift_card_restoration(
        order(), [usage(currentBalanceAmount=20.0, amountUsed=50.0, initialBalanceAmount=50.0)]
    )
    assert plans == []


def test_tiny_rounding_overshoot_is_still_allowed_and_capped():
    # overshoot of 0.005 is within the 0.01 epsilon, so it restores capped at initial balance
    plans = plan_gift_card_restoration(
        order(), [usage(currentBalanceAmount=0.005, amountUsed=50.0, initialBalanceAmount=50.0)]
    )
    assert plans[0]["restoreToAmount"] == 50.0


def test_multiple_usages_only_restores_the_eligible_one():
    usages = [
        usage(giftCardId="card-a", alreadyRestored=True),
        usage(giftCardId="card-b", alreadyRestored=False),
    ]
    plans = plan_gift_card_restoration(order(), usages)
    assert len(plans) == 1
    assert plans[0]["giftCardId"] == "card-b"


def test_empty_usages_returns_empty_plan():
    assert plan_gift_card_restoration(order(), []) == []
