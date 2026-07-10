from reconcile_stale_shipping import decide_stale_shipping

METHOD_A = {"id": "U2hpcHBpbmdNZXRob2Q6MQ=="}
METHOD_B = {"id": "U2hpcHBpbmdNZXRob2Q6Mg=="}


def test_not_stale_when_old_method_still_in_fresh_list():
    result = decide_stale_shipping(METHOD_A["id"], [METHOD_A, METHOD_B], [])
    assert result == {"isStale": False, "replacementId": METHOD_A["id"]}


def test_stale_when_old_method_missing_from_fresh_list():
    result = decide_stale_shipping(METHOD_A["id"], [METHOD_B], [])
    assert result == {"isStale": True, "replacementId": METHOD_B["id"]}


def test_stale_with_no_replacement_when_fresh_list_empty():
    result = decide_stale_shipping(METHOD_A["id"], [], [])
    assert result == {"isStale": True, "replacementId": None}


def test_not_stale_when_old_method_id_is_none():
    result = decide_stale_shipping(None, [METHOD_A], [])
    assert result == {"isStale": False, "replacementId": None}


def test_stale_when_problems_report_delivery_method_stale():
    problems = [{"__typename": "CheckoutProblemDeliveryMethodStale"}]
    result = decide_stale_shipping(METHOD_A["id"], [METHOD_A], problems)
    assert result == {"isStale": True, "replacementId": METHOD_A["id"]}


def test_stale_when_problems_report_delivery_method_invalid():
    problems = [{"__typename": "CheckoutProblemDeliveryMethodInvalid"}]
    result = decide_stale_shipping(METHOD_A["id"], [METHOD_A, METHOD_B], problems)
    assert result == {"isStale": True, "replacementId": METHOD_A["id"]}


def test_unrelated_problem_types_do_not_trigger_staleness():
    problems = [{"__typename": "CheckoutProblemInsufficientStock"}]
    result = decide_stale_shipping(METHOD_A["id"], [METHOD_A], problems)
    assert result == {"isStale": False, "replacementId": METHOD_A["id"]}


def test_none_old_method_with_stale_problem_reports_stale_with_no_replacement():
    problems = [{"__typename": "CheckoutProblemDeliveryMethodStale"}]
    result = decide_stale_shipping(None, [], problems)
    assert result == {"isStale": True, "replacementId": None}
