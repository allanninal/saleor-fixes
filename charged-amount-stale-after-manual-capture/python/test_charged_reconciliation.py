from reconcile_charged_amount import classify_charge_reconciliation


def saleor_txn(**over):
    base = {"chargedAmount": 0, "chargePendingAmount": 100, "events": []}
    base.update(over)
    return base


def gateway(**over):
    base = {"pspReference": "psp_1", "capturedAmount": 100, "status": "succeeded"}
    base.update(over)
    return base


def test_pending_gateway_is_in_sync():
    assert classify_charge_reconciliation(saleor_txn(), gateway(status="pending")) == "IN_SYNC"


def test_succeeded_with_no_matching_event_needs_report_success():
    assert classify_charge_reconciliation(saleor_txn(chargedAmount=0), gateway()) == "NEEDS_REPORT_SUCCESS"


def test_succeeded_with_matching_event_is_in_sync():
    txn = saleor_txn(chargedAmount=100, events=[{"type": "CHARGE_SUCCESS", "pspReference": "psp_1"}])
    assert classify_charge_reconciliation(txn, gateway()) == "IN_SYNC"


def test_saleor_over_reports_flags_mismatch():
    txn = saleor_txn(chargedAmount=150, events=[])
    assert classify_charge_reconciliation(txn, gateway()) == "AMOUNT_MISMATCH_FLAG"


def test_failed_gateway_with_open_pending_needs_report_failure():
    txn = saleor_txn(chargePendingAmount=100)
    assert classify_charge_reconciliation(txn, gateway(status="failed")) == "NEEDS_REPORT_FAILURE"


def test_failed_gateway_with_no_pending_is_in_sync():
    txn = saleor_txn(chargePendingAmount=0)
    assert classify_charge_reconciliation(txn, gateway(status="failed")) == "IN_SYNC"


def test_different_psp_reference_on_event_still_needs_report():
    txn = saleor_txn(chargedAmount=0, events=[{"type": "CHARGE_SUCCESS", "pspReference": "some_other_psp"}])
    assert classify_charge_reconciliation(txn, gateway()) == "NEEDS_REPORT_SUCCESS"


def test_wrong_event_type_still_needs_report():
    txn = saleor_txn(chargedAmount=0, events=[{"type": "CHARGE_FAILURE", "pspReference": "psp_1"}])
    assert classify_charge_reconciliation(txn, gateway()) == "NEEDS_REPORT_SUCCESS"
