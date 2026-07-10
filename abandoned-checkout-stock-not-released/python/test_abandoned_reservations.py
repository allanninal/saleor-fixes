from datetime import datetime, timezone
from release_stale_reservations import find_stale_reserved_checkouts

NOW = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)


def checkout(**over):
    base = {
        "id": "Q2hlY2tvdXQ6MQ==",
        "lastChange": "2026-07-09T23:00:00Z",
        "stockReservationExpires": None,
        "lines": [{"id": "Q2hlY2tvdXRMaW5lOjE=", "quantity": 1, "variantSku": "SKU-1"}],
    }
    base.update(over)
    return base


def test_flags_expired_reservation():
    result = find_stale_reserved_checkouts(
        [checkout(stockReservationExpires="2026-07-09T23:55:00Z")], NOW, 360
    )
    assert len(result) == 1
    assert result[0]["reason"] == "expired_reservation"
    assert result[0]["id"] == "Q2hlY2tvdXQ6MQ=="


def test_flags_past_ttl_when_no_expiry_set():
    result = find_stale_reserved_checkouts(
        [checkout(lastChange="2026-07-09T17:00:00Z")], NOW, 360
    )
    assert len(result) == 1
    assert result[0]["reason"] == "past_ttl"


def test_skips_checkout_within_ttl_and_no_expiry():
    result = find_stale_reserved_checkouts(
        [checkout(lastChange="2026-07-09T23:00:00Z")], NOW, 360
    )
    assert result == []


def test_skips_checkout_with_future_expiry():
    result = find_stale_reserved_checkouts(
        [checkout(stockReservationExpires="2026-07-10T01:00:00Z", lastChange="2026-07-09T23:50:00Z")],
        NOW,
        360,
    )
    assert result == []


def test_returns_line_ids():
    lines = [{"id": "A"}, {"id": "B"}]
    result = find_stale_reserved_checkouts(
        [checkout(stockReservationExpires="2026-07-09T20:00:00Z", lines=lines)], NOW, 360
    )
    assert result[0]["lineIds"] == ["A", "B"]


def test_skips_checkout_with_no_last_change_and_no_expiry():
    result = find_stale_reserved_checkouts([checkout(lastChange=None)], NOW, 360)
    assert result == []


def test_exactly_at_expiry_is_stale():
    result = find_stale_reserved_checkouts(
        [checkout(stockReservationExpires="2026-07-10T00:00:00Z")], NOW, 360
    )
    assert len(result) == 1
    assert result[0]["reason"] == "expired_reservation"


def test_exactly_at_ttl_is_stale():
    result = find_stale_reserved_checkouts(
        [checkout(lastChange="2026-07-09T18:00:00Z")], NOW, 360
    )
    assert len(result) == 1
    assert result[0]["reason"] == "past_ttl"
