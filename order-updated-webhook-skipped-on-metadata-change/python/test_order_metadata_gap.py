from detect_metadata_webhook_gap import classify_metadata_webhook_gap

WRITE_AT = "2026-07-10T12:00:00Z"


def test_misconfigured_when_not_subscribed_to_metadata_event():
    result = classify_metadata_webhook_gap(WRITE_AT, [], {"ORDER_UPDATED"})
    assert result == "MISCONFIGURED_SUBSCRIPTION"


def test_misconfigured_even_with_unrelated_deliveries():
    deliveries = [{"eventType": "ORDER_UPDATED", "createdAt": "2026-07-10T13:00:00Z"}]
    result = classify_metadata_webhook_gap(WRITE_AT, deliveries, {"ORDER_UPDATED"})
    assert result == "MISCONFIGURED_SUBSCRIPTION"


def test_delivery_missing_when_subscribed_but_no_matching_delivery():
    result = classify_metadata_webhook_gap(WRITE_AT, [], {"ORDER_UPDATED", "ORDER_METADATA_UPDATED"})
    assert result == "DELIVERY_MISSING"


def test_delivery_missing_when_only_delivery_is_before_the_write():
    deliveries = [{"eventType": "ORDER_METADATA_UPDATED", "createdAt": "2026-07-10T11:00:00Z"}]
    result = classify_metadata_webhook_gap(WRITE_AT, deliveries, {"ORDER_UPDATED", "ORDER_METADATA_UPDATED"})
    assert result == "DELIVERY_MISSING"


def test_ok_when_matching_delivery_exists_after_the_write():
    deliveries = [{"eventType": "ORDER_METADATA_UPDATED", "createdAt": "2026-07-10T12:00:01Z"}]
    result = classify_metadata_webhook_gap(WRITE_AT, deliveries, {"ORDER_UPDATED", "ORDER_METADATA_UPDATED"})
    assert result == "OK"


def test_ok_when_delivery_exactly_at_the_write_time():
    deliveries = [{"eventType": "ORDER_METADATA_UPDATED", "createdAt": WRITE_AT}]
    result = classify_metadata_webhook_gap(WRITE_AT, deliveries, {"ORDER_UPDATED", "ORDER_METADATA_UPDATED"})
    assert result == "OK"


def test_ignores_deliveries_of_other_event_types():
    deliveries = [{"eventType": "ORDER_UPDATED", "createdAt": "2026-07-10T12:00:01Z"}]
    result = classify_metadata_webhook_gap(WRITE_AT, deliveries, {"ORDER_UPDATED", "ORDER_METADATA_UPDATED"})
    assert result == "DELIVERY_MISSING"
