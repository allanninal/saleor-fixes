import datetime
from reconcile_stuck_orders import classify_stuck_order, has_open_allocation

NOW = datetime.datetime(2026, 7, 10, tzinfo=datetime.timezone.utc)


def order(**over):
    base = {
        "status": "UNFULFILLED",
        "isPaid": False,
        "paymentStatus": "NOT_CHARGED",
        "createdAt": NOW - datetime.timedelta(hours=100),
        "channelExpireOrdersAfterMin": None,
    }
    base.update(over)
    return base


def test_ok_when_already_paid():
    assert classify_stuck_order(order(isPaid=True), NOW, 72) == "OK"


def test_ok_when_already_cancelled():
    assert classify_stuck_order(order(status="CANCELED"), NOW, 72) == "OK"


def test_ok_when_already_expired():
    assert classify_stuck_order(order(status="EXPIRED"), NOW, 72) == "OK"


def test_ok_when_already_fulfilled():
    assert classify_stuck_order(order(status="FULFILLED"), NOW, 72) == "OK"


def test_ok_when_recent():
    o = order(createdAt=NOW - datetime.timedelta(hours=10))
    assert classify_stuck_order(o, NOW, 72) == "OK"


def test_cancel_when_unfulfilled_stale_and_unpaid():
    assert classify_stuck_order(order(), NOW, 72) == "CANCEL"


def test_cancel_when_unconfirmed_and_no_native_expiration_configured():
    o = order(status="UNCONFIRMED", channelExpireOrdersAfterMin=None)
    assert classify_stuck_order(o, NOW, 72) == "CANCEL"


def test_ok_when_unconfirmed_and_native_expiration_has_not_elapsed():
    o = order(
        status="UNCONFIRMED",
        channelExpireOrdersAfterMin=999999,
        createdAt=NOW - datetime.timedelta(hours=100),
    )
    assert classify_stuck_order(o, NOW, 72) == "OK"


def test_cancel_when_unconfirmed_and_native_expiration_already_elapsed():
    # expireOrdersAfter configured but age already exceeds it: the Celery
    # task should have caught this and did not, so we still classify it.
    o = order(
        status="UNCONFIRMED",
        channelExpireOrdersAfterMin=60,  # 1 hour
        createdAt=NOW - datetime.timedelta(hours=100),
    )
    assert classify_stuck_order(o, NOW, 72) == "CANCEL"


def test_deallocate_only_when_partially_fulfilled():
    assert classify_stuck_order(order(status="PARTIALLY_FULFILLED"), NOW, 72) == "DEALLOCATE_ONLY"


def test_ok_when_paid_status_not_unpaid():
    o = order(paymentStatus="FULLY_CHARGED")
    assert classify_stuck_order(o, NOW, 72) == "OK"


def test_ok_when_exactly_at_stale_boundary_not_yet_over():
    o = order(createdAt=NOW - datetime.timedelta(hours=72))
    assert classify_stuck_order(o, NOW, 72) == "OK"


def test_cancel_when_just_over_stale_boundary():
    o = order(createdAt=NOW - datetime.timedelta(hours=72, minutes=1))
    assert classify_stuck_order(o, NOW, 72) == "CANCEL"


def test_has_open_allocation_true_when_line_not_fully_fulfilled():
    o = {"lines": [{"quantity": 3, "quantityFulfilled": 1}]}
    assert has_open_allocation(o) is True


def test_has_open_allocation_false_when_all_lines_fulfilled():
    o = {"lines": [{"quantity": 3, "quantityFulfilled": 3}]}
    assert has_open_allocation(o) is False


def test_has_open_allocation_false_when_no_lines():
    assert has_open_allocation({"lines": []}) is False
