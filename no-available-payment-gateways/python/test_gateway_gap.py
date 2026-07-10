from find_gateway_gaps import decide_gateway_gap

CHANNEL_US = {"slug": "us", "currencyCode": "USD"}
CHANNEL_EU = {"slug": "eu", "currencyCode": "EUR"}


def plugin_config(**over):
    base = {"channelSlug": "us", "active": True}
    base.update(over)
    return base


def app(**over):
    base = {"appId": "QXBwOjE=", "isActive": True, "gateways": [{"id": "app.gateway", "currencies": ["USD"]}]}
    base.update(over)
    return base


def test_available_when_plugin_active_for_channel():
    result = decide_gateway_gap(CHANNEL_US, [plugin_config()], [])
    assert result == {"channelSlug": "us", "hasAvailableGateway": True, "reasons": []}


def test_flagged_when_plugin_has_no_entry_for_channel():
    result = decide_gateway_gap(CHANNEL_EU, [plugin_config()], [])
    assert result["hasAvailableGateway"] is False
    assert "plugin_inactive_for_channel" in result["reasons"]


def test_flagged_when_plugin_entry_inactive():
    result = decide_gateway_gap(CHANNEL_US, [plugin_config(active=False)], [])
    assert result["hasAvailableGateway"] is False
    assert "plugin_inactive_for_channel" in result["reasons"]


def test_available_when_active_app_matches_currency():
    result = decide_gateway_gap(CHANNEL_US, [], [app()])
    assert result["hasAvailableGateway"] is True


def test_flagged_when_app_disabled():
    result = decide_gateway_gap(CHANNEL_US, [], [app(isActive=False)])
    assert result["hasAvailableGateway"] is False
    assert "app_disabled" in result["reasons"]


def test_flagged_when_app_currency_mismatch():
    result = decide_gateway_gap(CHANNEL_EU, [], [app()])
    assert result["hasAvailableGateway"] is False
    assert "currency_mismatch" in result["reasons"]


def test_available_when_either_plugin_or_app_covers_channel():
    result = decide_gateway_gap(CHANNEL_US, [plugin_config(active=False)], [app()])
    assert result["hasAvailableGateway"] is True


def test_flagged_with_no_plugin_and_no_apps_at_all():
    result = decide_gateway_gap(CHANNEL_US, [], [])
    assert result["hasAvailableGateway"] is False
    assert "plugin_inactive_for_channel" in result["reasons"]


def test_flagged_when_multiple_apps_all_disabled():
    result = decide_gateway_gap(CHANNEL_US, [], [app(isActive=False), app(isActive=False, appId="QXBwOjI=")])
    assert result["hasAvailableGateway"] is False
    assert result["reasons"].count("app_disabled") == 2
