import datetime
from flag_stuck_unfulfilled import classify_stuck_order

NOW = datetime.datetime(2026, 7, 10, tzinfo=datetime.timezone.utc)


def call(**over):
    base = {
        "status": "UNFULFILLED",
        "is_paid": True,
        "payment_charge_status": "FULLY_CHARGED",
        "fulfillments": [],
        "updated_at": NOW - datetime.timedelta(minutes=60),
        "now": NOW,
        "stale_minutes": 30,
    }
    base.update(over)
    return classify_stuck_order(
        base["status"], base["is_paid"], base["payment_charge_status"],
        base["fulfillments"], base["updated_at"], base["now"], base["stale_minutes"],
    )


def test_stuck_when_paid_unfulfilled_no_fulfillment_and_stale():
    result = call()
    assert result["stuck"] is True
    assert result["reason"] == "paid_but_no_fulfillment_past_threshold"


def test_not_stuck_when_status_is_not_unfulfilled():
    result = call(status="FULFILLED")
    assert result == {"stuck": False, "reason": "not_unfulfilled"}


def test_not_stuck_when_partially_fulfilled():
    result = call(status="PARTIALLY_FULFILLED")
    assert result == {"stuck": False, "reason": "not_unfulfilled"}


def test_not_stuck_when_not_paid():
    result = call(is_paid=False, payment_charge_status="NOT_CHARGED")
    assert result == {"stuck": False, "reason": "not_paid"}


def test_paid_via_partially_charged_still_counts_as_paid():
    result = call(is_paid=False, payment_charge_status="PARTIALLY_CHARGED")
    assert result["stuck"] is True


def test_not_stuck_when_active_fulfillment_exists():
    result = call(fulfillments=[{"id": "Zg==", "status": "FULFILLED"}])
    assert result == {"stuck": False, "reason": "has_active_fulfillment"}


def test_stuck_when_only_fulfillment_is_cancelled():
    result = call(fulfillments=[{"id": "Zg==", "status": "CANCELED"}])
    assert result["stuck"] is True


def test_not_stuck_when_mix_of_cancelled_and_active_fulfillments():
    result = call(fulfillments=[
        {"id": "Zg==", "status": "CANCELED"},
        {"id": "Zh==", "status": "FULFILLED"},
    ])
    assert result == {"stuck": False, "reason": "has_active_fulfillment"}


def test_not_stuck_within_processing_window():
    result = call(updated_at=NOW - datetime.timedelta(minutes=5))
    assert result == {"stuck": False, "reason": "within_processing_window"}


def test_exactly_at_threshold_is_stuck():
    result = call(updated_at=NOW - datetime.timedelta(minutes=30))
    assert result["stuck"] is True


def test_isPaid_true_overrides_missing_charge_status():
    result = call(is_paid=True, payment_charge_status=None)
    assert result["stuck"] is True
