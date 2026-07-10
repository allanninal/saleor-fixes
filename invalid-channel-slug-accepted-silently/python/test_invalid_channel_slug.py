from validate_channel_slug import decide_channel_slug_validity, require_valid_channel, InvalidChannelSlugError

CHANNELS = [
    {"slug": "default-channel", "isActive": True},
    {"slug": "us-store", "isActive": True},
    {"slug": "eu-store", "isActive": False},
]


def test_exact_match_is_valid():
    assert decide_channel_slug_validity("us-store", CHANNELS) == {"status": "VALID", "suggestion": None}


def test_exact_match_on_inactive_channel_is_inactive():
    assert decide_channel_slug_validity("eu-store", CHANNELS) == {"status": "INACTIVE", "suggestion": None}


def test_typo_is_unknown_with_close_suggestion():
    result = decide_channel_slug_validity("us-stor", CHANNELS)
    assert result["status"] == "UNKNOWN"
    assert result["suggestion"] == "us-store"


def test_completely_unrelated_slug_has_no_suggestion():
    result = decide_channel_slug_validity("zzz-totally-different", CHANNELS)
    assert result["status"] == "UNKNOWN"
    assert result["suggestion"] is None


def test_empty_known_channels_is_unknown_with_no_suggestion():
    assert decide_channel_slug_validity("us-store", []) == {"status": "UNKNOWN", "suggestion": None}


def test_short_prefix_match_can_still_suggest():
    result = decide_channel_slug_validity("us", CHANNELS)
    assert result["status"] == "UNKNOWN"
    assert result["suggestion"] == "us-store"


def test_require_valid_channel_raises_with_suggestion():
    try:
        require_valid_channel("us-stor", CHANNELS, call_site="products(channel=...)")
        assert False, "expected InvalidChannelSlugError"
    except InvalidChannelSlugError as err:
        assert "us-stor" in str(err)
        assert "us-store" in str(err)


def test_require_valid_channel_does_not_raise_for_valid_slug():
    decision = require_valid_channel("default-channel", CHANNELS)
    assert decision["status"] == "VALID"


def test_require_valid_channel_does_not_raise_for_inactive_slug():
    decision = require_valid_channel("eu-store", CHANNELS)
    assert decision["status"] == "INACTIVE"
