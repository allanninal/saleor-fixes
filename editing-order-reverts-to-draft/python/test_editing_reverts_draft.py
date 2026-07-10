from flag_orphaned_drafts import is_orphaned_draft_with_payment


def order(**over):
    base = {
        "status": "DRAFT",
        "payments": [{"id": "UGF5bWVudDox", "isActive": True, "chargeStatus": "FULLY_CHARGED"}],
        "transactions": [],
    }
    base.update(over)
    return base


def test_flagged_when_draft_with_charged_active_payment():
    assert is_orphaned_draft_with_payment(order()) is True


def test_flagged_when_draft_with_transaction_and_no_payment():
    o = order(payments=[], transactions=[{"id": "VHJhbnNhY3Rpb25JdGVtOjE="}])
    assert is_orphaned_draft_with_payment(o) is True


def test_not_flagged_when_not_draft():
    o = order(status="UNFULFILLED")
    assert is_orphaned_draft_with_payment(o) is False


def test_not_flagged_when_draft_with_no_payment_or_transaction():
    o = order(payments=[], transactions=[])
    assert is_orphaned_draft_with_payment(o) is False


def test_not_flagged_when_payment_is_not_charged():
    o = order(payments=[{"id": "UGF5bWVudDox", "isActive": True, "chargeStatus": "NOT_CHARGED"}])
    assert is_orphaned_draft_with_payment(o) is False


def test_not_flagged_when_payment_is_inactive():
    o = order(payments=[{"id": "UGF5bWVudDox", "isActive": False, "chargeStatus": "FULLY_CHARGED"}])
    assert is_orphaned_draft_with_payment(o) is False


def test_flagged_when_multiple_payments_and_only_one_qualifies():
    o = order(payments=[
        {"id": "UGF5bWVudDox", "isActive": False, "chargeStatus": "FULLY_CHARGED"},
        {"id": "UGF5bWVudDoy", "isActive": True, "chargeStatus": "PARTIALLY_CHARGED"},
    ])
    assert is_orphaned_draft_with_payment(o) is True


def test_not_flagged_when_status_missing():
    o = order()
    del o["status"]
    assert is_orphaned_draft_with_payment(o) is False
