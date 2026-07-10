from find_missing_shipping_coverage import (
    find_channels_missing_shipping_coverage,
    find_unambiguous_repair,
)

CH_A = {"id": "Q2hhbm5lbDox"}
CH_B = {"id": "Q2hhbm5lbDoy"}


def zone(**over):
    base = {
        "id": "U2hpcHBpbmdab25lOjE=",
        "channels": [{"id": "Q2hhbm5lbDox"}],
        "warehouses": [{"id": "V2FyZWhvdXNlOjE=", "channels": [{"id": "Q2hhbm5lbDox"}]}],
        "shippingMethods": [
            {"id": "U2hpcHBpbmdNZXRob2Q6MQ==", "name": "Standard",
             "channelListings": [{"channel": {"id": "Q2hhbm5lbDox"}}]}
        ],
    }
    base.update(over)
    return base


def test_channel_fully_covered_is_not_flagged():
    assert find_channels_missing_shipping_coverage([CH_A], [zone()]) == []


def test_channel_with_no_zone_is_flagged():
    result = find_channels_missing_shipping_coverage([CH_B], [zone()])
    assert result == [{"channelId": "Q2hhbm5lbDoy", "reason": "NO_ZONE"}]


def test_channel_with_zone_but_no_warehouse_is_flagged():
    z = zone(warehouses=[{"id": "V2FyZWhvdXNlOjE=", "channels": []}])
    result = find_channels_missing_shipping_coverage([CH_A], [z])
    assert result == [{"channelId": "Q2hhbm5lbDox", "reason": "NO_WAREHOUSE_IN_CHANNEL"}]


def test_channel_with_zone_and_warehouse_but_no_listed_method_is_flagged():
    z = zone(shippingMethods=[{"id": "U2hpcHBpbmdNZXRob2Q6MQ==", "name": "Standard", "channelListings": []}])
    result = find_channels_missing_shipping_coverage([CH_A], [z])
    assert result == [{"channelId": "Q2hhbm5lbDox", "reason": "NO_METHOD_LISTED"}]


def test_multiple_channels_only_flags_the_broken_one():
    result = find_channels_missing_shipping_coverage([CH_A, CH_B], [zone()])
    assert result == [{"channelId": "Q2hhbm5lbDoy", "reason": "NO_ZONE"}]


def test_zone_with_no_channels_at_all_flags_every_channel():
    z = zone(channels=[])
    result = find_channels_missing_shipping_coverage([CH_A, CH_B], [z])
    assert result == [
        {"channelId": "Q2hhbm5lbDox", "reason": "NO_ZONE"},
        {"channelId": "Q2hhbm5lbDoy", "reason": "NO_ZONE"},
    ]


def test_no_shipping_methods_at_all_still_flags_no_zone_first():
    result = find_channels_missing_shipping_coverage([CH_B], [])
    assert result == [{"channelId": "Q2hhbm5lbDoy", "reason": "NO_ZONE"}]


def test_unambiguous_repair_found_when_zone_scoped_to_one_channel():
    z = zone(shippingMethods=[{"id": "U2hpcHBpbmdNZXRob2Q6MQ==", "name": "Standard", "channelListings": []}])
    repair = find_unambiguous_repair(CH_A, [z])
    assert repair == {"shippingMethodId": "U2hpcHBpbmdNZXRob2Q6MQ==", "shippingMethodName": "Standard"}


def test_no_repair_when_zone_shared_by_multiple_channels():
    z = zone(channels=[{"id": "Q2hhbm5lbDox"}, {"id": "Q2hhbm5lbDoy"}],
             shippingMethods=[{"id": "U2hpcHBpbmdNZXRob2Q6MQ==", "name": "Standard", "channelListings": []}])
    assert find_unambiguous_repair(CH_A, [z]) is None


def test_no_repair_when_method_already_listed():
    assert find_unambiguous_repair(CH_A, [zone()]) is None
