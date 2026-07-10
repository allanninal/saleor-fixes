from audit_gift_card_balances import classify_gift_card_balance_overwrite


def event(**over):
    base = {
        "type": "UPDATED",
        "oldInitialBalanceAmount": None,
        "oldCurrentBalanceAmount": None,
        "newInitialBalanceAmount": None,
        "newCurrentBalanceAmount": None,
    }
    base.update(over)
    return base


def card(**over):
    base = {"initialBalanceAmount": 50, "currentBalanceAmount": 50, "events": []}
    base.update(over)
    return base


def test_not_affected_for_a_healthy_untouched_card():
    result = classify_gift_card_balance_overwrite(card())
    assert result == {"affected": False, "reason": None, "recoveredCurrentBalanceAmount": None}


def test_current_exceeds_initial_is_unrecoverable():
    result = classify_gift_card_balance_overwrite(card(initialBalanceAmount=50, currentBalanceAmount=60))
    assert result == {"affected": True, "reason": "current_exceeds_initial", "recoveredCurrentBalanceAmount": None}


def test_update_reset_a_spent_card_recovers_old_current_balance():
    c = card(initialBalanceAmount=60, currentBalanceAmount=60, events=[
        event(oldInitialBalanceAmount=50, oldCurrentBalanceAmount=12,
              newInitialBalanceAmount=60, newCurrentBalanceAmount=60),
    ])
    result = classify_gift_card_balance_overwrite(c)
    assert result == {"affected": True, "reason": "update_reset_spent_card", "recoveredCurrentBalanceAmount": 12}


def test_update_on_a_never_spent_card_is_not_flagged():
    c = card(initialBalanceAmount=60, currentBalanceAmount=60, events=[
        event(oldInitialBalanceAmount=50, oldCurrentBalanceAmount=50,
              newInitialBalanceAmount=60, newCurrentBalanceAmount=60),
    ])
    result = classify_gift_card_balance_overwrite(c)
    assert result == {"affected": False, "reason": None, "recoveredCurrentBalanceAmount": None}


def test_update_that_keeps_balances_apart_is_not_flagged():
    c = card(initialBalanceAmount=50, currentBalanceAmount=20, events=[
        event(oldInitialBalanceAmount=50, oldCurrentBalanceAmount=30,
              newInitialBalanceAmount=50, newCurrentBalanceAmount=20),
    ])
    result = classify_gift_card_balance_overwrite(c)
    assert result == {"affected": False, "reason": None, "recoveredCurrentBalanceAmount": None}


def test_events_with_missing_balance_data_are_skipped_not_crashed():
    c = card(events=[event(type="ISSUED")])
    result = classify_gift_card_balance_overwrite(c)
    assert result == {"affected": False, "reason": None, "recoveredCurrentBalanceAmount": None}


def test_earliest_matching_update_wins_when_scanning_chronologically():
    c = card(initialBalanceAmount=60, currentBalanceAmount=60, events=[
        event(oldInitialBalanceAmount=50, oldCurrentBalanceAmount=12,
              newInitialBalanceAmount=60, newCurrentBalanceAmount=60),
        event(oldInitialBalanceAmount=60, oldCurrentBalanceAmount=12,
              newInitialBalanceAmount=90, newCurrentBalanceAmount=90),
    ])
    result = classify_gift_card_balance_overwrite(c)
    assert result["recoveredCurrentBalanceAmount"] == 12


def test_current_exceeds_initial_takes_priority_over_event_scan():
    # Even if events look fine, the literal balance anomaly is checked first.
    c = card(initialBalanceAmount=40, currentBalanceAmount=45, events=[
        event(oldInitialBalanceAmount=40, oldCurrentBalanceAmount=40,
              newInitialBalanceAmount=40, newCurrentBalanceAmount=40),
    ])
    result = classify_gift_card_balance_overwrite(c)
    assert result == {"affected": True, "reason": "current_exceeds_initial", "recoveredCurrentBalanceAmount": None}
