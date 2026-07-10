from flag_stale_checkout import classify_stale_checkout

HOUR_MS = 3600 * 1000


def checkout(**over):
    base = {
        "id": "checkout-1",
        "token": "tok-1",
        "createdAt": "2026-07-01T00:00:00Z",
        "updatedAt": "2026-07-09T12:00:00Z",
        "userEmail": "buyer@example.com",
        "channelSlug": "default-channel",
        "voucherCode": None,
        "lines": [{"variantId": "v-1", "isChannelListed": True}],
        "expectedSessionId": None,
        "storedSessionMeta": None,
        "voucherIsActive": None,
        "now": "2026-07-10T00:00:00Z",
    }
    base.update(over)
    return base


def test_not_stale_by_default():
    result = classify_stale_checkout(checkout(), 48 * HOUR_MS)
    assert result == {"stale": False, "reasons": []}


def test_session_mismatch_flagged():
    result = classify_stale_checkout(
        checkout(expectedSessionId="sess-new", storedSessionMeta="sess-old"), 48 * HOUR_MS
    )
    assert result["stale"] is True
    assert "session_mismatch" in result["reasons"]


def test_orphaned_voucher_flagged():
    result = classify_stale_checkout(
        checkout(voucherCode="SUMMER10", voucherIsActive=False), 48 * HOUR_MS
    )
    assert result["stale"] is True
    assert "orphaned_voucher" in result["reasons"]


def test_active_voucher_not_flagged():
    result = classify_stale_checkout(
        checkout(voucherCode="SUMMER10", voucherIsActive=True), 48 * HOUR_MS
    )
    assert result["stale"] is False


def test_delisted_line_flagged():
    result = classify_stale_checkout(
        checkout(lines=[{"variantId": "v-1", "isChannelListed": False}]), 48 * HOUR_MS
    )
    assert result["stale"] is True
    assert "delisted_line" in result["reasons"]


def test_long_idle_flagged():
    result = classify_stale_checkout(checkout(), 6 * HOUR_MS)
    assert result["stale"] is True
    assert "long_idle" in result["reasons"]


def test_multiple_reasons_all_reported():
    result = classify_stale_checkout(
        checkout(
            voucherCode="OLD5",
            voucherIsActive=False,
            lines=[{"variantId": "v-2", "isChannelListed": False}],
        ),
        6 * HOUR_MS,
    )
    assert result["stale"] is True
    assert set(result["reasons"]) == {"orphaned_voucher", "delisted_line", "long_idle"}
