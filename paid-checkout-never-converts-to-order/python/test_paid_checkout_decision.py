from complete_paid_checkouts import should_complete_checkout

NOW = "2026-07-10T00:30:00+00:00"


def checkout(**over):
    base = {
        "hasOrder": False,
        "authorizeStatus": "FULL",
        "chargeStatus": "FULL",
        "createdAt": "2026-07-10T00:20:00+00:00",  # 10 minutes old
    }
    base.update(over)
    return base


def test_completes_when_paid_aged_and_no_order():
    result = should_complete_checkout(checkout(), NOW, grace_minutes=5)
    assert result["action"] == "complete"


def test_skips_when_already_has_order():
    result = should_complete_checkout(checkout(hasOrder=True), NOW, grace_minutes=5)
    assert result["action"] == "skip"


def test_skips_when_not_fully_authorized():
    result = should_complete_checkout(checkout(authorizeStatus="PARTIAL"), NOW, grace_minutes=5)
    assert result["action"] == "skip"


def test_skips_when_no_authorization_yet():
    result = should_complete_checkout(checkout(authorizeStatus="NONE"), NOW, grace_minutes=5)
    assert result["action"] == "skip"


def test_skips_when_too_new():
    result = should_complete_checkout(checkout(createdAt="2026-07-10T00:27:00+00:00"), NOW, grace_minutes=5)
    assert result["action"] == "skip"


def test_flags_when_charge_status_pending():
    result = should_complete_checkout(checkout(chargeStatus="PENDING"), NOW, grace_minutes=5)
    assert result["action"] == "flag"


def test_flags_when_charge_status_partial():
    result = should_complete_checkout(checkout(chargeStatus="PARTIAL"), NOW, grace_minutes=5)
    assert result["action"] == "flag"


def test_exactly_at_grace_period_completes():
    result = should_complete_checkout(checkout(createdAt="2026-07-10T00:25:00+00:00"), NOW, grace_minutes=5)
    assert result["action"] == "complete"
