from retry_dropped_events import classify_dropped_deliveries

DISABLED_AT = "2026-06-25T09:00:00Z"
REENABLED_AT = "2026-06-25T11:30:00Z"
NOW = "2026-06-30T09:00:00Z"


def delivery(**over):
    base = {
        "id": "gid://saleor/EventDelivery/1",
        "createdAt": "2026-06-25T10:00:00Z",
        "status": "FAILED",
        "eventType": "ORDER_CREATED",
        "payload": '{"id": "gid://saleor/Order/1"}',
    }
    base.update(over)
    return base


def test_before_window_is_skipped():
    d = delivery(createdAt="2026-06-25T08:00:00Z")
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, NOW)
    assert result == [{"id": d["id"], "action": "SKIP"}]


def test_inside_window_with_payload_is_retried():
    d = delivery()
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, NOW)
    assert result == [{"id": d["id"], "action": "RETRY"}]


def test_inside_window_past_retention_is_unrecoverable():
    old_now = "2026-07-15T09:00:00Z"  # more than 14 days after createdAt
    d = delivery()
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, old_now)
    assert result == [{"id": d["id"], "action": "FLAG_UNRECOVERABLE"}]


def test_inside_window_null_payload_is_unrecoverable():
    d = delivery(payload=None)
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, NOW)
    assert result == [{"id": d["id"], "action": "FLAG_UNRECOVERABLE"}]


def test_success_status_inside_window_is_skipped():
    d = delivery(status="SUCCESS")
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, NOW)
    assert result == [{"id": d["id"], "action": "SKIP"}]


def test_pending_status_inside_window_is_skipped():
    d = delivery(status="PENDING")
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, NOW)
    assert result == [{"id": d["id"], "action": "SKIP"}]


def test_after_window_is_skipped():
    d = delivery(createdAt="2026-06-25T12:00:00Z")
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, NOW)
    assert result == [{"id": d["id"], "action": "SKIP"}]


def test_no_reenabled_at_uses_now_as_window_end():
    d = delivery(createdAt="2026-06-29T09:00:00Z")
    result = classify_dropped_deliveries([d], DISABLED_AT, None, NOW)
    assert result == [{"id": d["id"], "action": "RETRY"}]


def test_exactly_at_retention_boundary_is_retried():
    # createdAt + 14 days exactly == now, so age_days == retention_days (not > retention_days)
    d = delivery(createdAt="2026-06-25T10:00:00Z")
    now_at_boundary = "2026-07-09T10:00:00Z"
    result = classify_dropped_deliveries([d], DISABLED_AT, REENABLED_AT, now_at_boundary)
    assert result == [{"id": d["id"], "action": "RETRY"}]


def test_multiple_deliveries_mixed_actions():
    deliveries = [
        delivery(id="a", createdAt="2026-06-25T08:00:00Z"),  # before window -> SKIP
        delivery(id="b"),  # in window with payload -> RETRY
        delivery(id="c", payload=None),  # in window, null payload -> FLAG_UNRECOVERABLE
        delivery(id="d", status="SUCCESS"),  # not FAILED -> SKIP
    ]
    result = classify_dropped_deliveries(deliveries, DISABLED_AT, REENABLED_AT, NOW)
    assert result == [
        {"id": "a", "action": "SKIP"},
        {"id": "b", "action": "RETRY"},
        {"id": "c", "action": "FLAG_UNRECOVERABLE"},
        {"id": "d", "action": "SKIP"},
    ]
