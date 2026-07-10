import datetime
from flag_confirmation_timing import decide_confirmation_timing_issue

NOW = datetime.datetime(2026, 7, 10, tzinfo=datetime.timezone.utc)


def hours_ago(h):
    return NOW - datetime.timedelta(hours=h)


def test_ok_when_no_confirmation_was_ever_sent():
    result = decide_confirmation_timing_issue(None, hours_ago(1), False, NOW)
    assert result == "ok"


def test_ok_when_charge_succeeded_before_confirmation():
    confirm = hours_ago(1)
    charge = hours_ago(2)
    result = decide_confirmation_timing_issue(confirm, charge, False, NOW)
    assert result == "ok"


def test_ok_when_charge_succeeded_after_confirmation_same_request():
    confirm = hours_ago(2)
    charge = hours_ago(1)
    result = decide_confirmation_timing_issue(confirm, charge, False, NOW)
    assert result == "ok"


def test_ok_when_confirm_equals_charge_timestamp():
    ts = hours_ago(3)
    result = decide_confirmation_timing_issue(ts, ts, False, NOW)
    assert result == "ok"


def test_ok_when_no_charge_but_order_is_paid_another_way():
    result = decide_confirmation_timing_issue(hours_ago(30), None, True, NOW)
    assert result == "ok"


def test_flag_email_premature_when_recent_and_unpaid_with_no_charge():
    result = decide_confirmation_timing_issue(hours_ago(1), None, False, NOW, cancel_grace_hours=24)
    assert result == "flag_email_premature"


def test_flag_and_eligible_for_cancel_past_grace_window():
    result = decide_confirmation_timing_issue(hours_ago(25), None, False, NOW, cancel_grace_hours=24)
    assert result == "flag_and_eligible_for_cancel"


def test_exactly_at_grace_window_is_eligible_for_cancel():
    result = decide_confirmation_timing_issue(hours_ago(24), None, False, NOW, cancel_grace_hours=24)
    assert result == "flag_and_eligible_for_cancel"


def test_custom_grace_window_is_respected():
    result = decide_confirmation_timing_issue(hours_ago(5), None, False, NOW, cancel_grace_hours=4)
    assert result == "flag_and_eligible_for_cancel"


def test_just_under_grace_window_is_still_premature():
    result = decide_confirmation_timing_issue(hours_ago(23), None, False, NOW, cancel_grace_hours=24)
    assert result == "flag_email_premature"
