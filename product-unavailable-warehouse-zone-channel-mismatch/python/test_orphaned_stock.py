from find_orphaned_stock import find_orphaned_stock, to_variant_stock_records

CHANNEL = {"slug": "default-channel", "warehouseIds": {"V2FyZWhvdXNlOjE="}}


def record(**over):
    base = {
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "warehouseId": "V2FyZWhvdXNlOjE=",
        "quantity": 10,
        "warehouseChannelSlugs": ["default-channel"],
        "warehouseZones": [
            {"id": "U2hpcHBpbmdab25lOjE=", "channelSlugs": ["default-channel"], "countries": ["US"]}
        ],
    }
    base.update(over)
    return base


def test_reachable_stock_is_not_flagged():
    assert find_orphaned_stock([record()], CHANNEL, legacy_mode=False) == []


def test_zero_quantity_is_ignored_even_if_unlinked():
    r = record(quantity=0, warehouseChannelSlugs=[])
    assert find_orphaned_stock([r], CHANNEL, legacy_mode=False) == []


def test_warehouse_not_linked_to_channel_is_flagged():
    r = record(warehouseChannelSlugs=[])
    result = find_orphaned_stock([r], CHANNEL, legacy_mode=False)
    assert result == [{
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "warehouseId": "V2FyZWhvdXNlOjE=",
        "reason": "warehouse not linked to channel",
    }]


def test_legacy_mode_off_ignores_zone_gap():
    r = record(warehouseZones=[])
    assert find_orphaned_stock([r], CHANNEL, legacy_mode=False) == []


def test_legacy_mode_on_flags_missing_zone_channel_link():
    r = record(warehouseZones=[{"id": "Z1", "channelSlugs": [], "countries": ["US"]}])
    result = find_orphaned_stock([r], CHANNEL, legacy_mode=True)
    assert result == [{
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "warehouseId": "V2FyZWhvdXNlOjE=",
        "reason": "warehouse zone not linked to channel/destination",
    }]


def test_legacy_mode_on_and_zone_matches_is_not_flagged():
    result = find_orphaned_stock([record()], CHANNEL, legacy_mode=True)
    assert result == []


def test_legacy_mode_on_with_destination_country_not_covered_is_flagged():
    r = record(warehouseZones=[{"id": "Z1", "channelSlugs": ["default-channel"], "countries": ["DE"]}])
    result = find_orphaned_stock([r], CHANNEL, legacy_mode=True, destination_country="US")
    assert result == [{
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "warehouseId": "V2FyZWhvdXNlOjE=",
        "reason": "warehouse zone not linked to channel/destination",
    }]


def test_legacy_mode_on_with_destination_country_covered_is_not_flagged():
    result = find_orphaned_stock([record()], CHANNEL, legacy_mode=True, destination_country="US")
    assert result == []


def test_multiple_zones_only_one_matching_is_enough():
    r = record(warehouseZones=[
        {"id": "Z1", "channelSlugs": [], "countries": ["US"]},
        {"id": "Z2", "channelSlugs": ["default-channel"], "countries": ["US"]},
    ])
    assert find_orphaned_stock([r], CHANNEL, legacy_mode=True) == []


def test_multiple_records_flags_only_the_broken_one():
    good = record()
    bad = record(variantId="UHJvZHVjdFZhcmlhbnQ6Mg==", warehouseChannelSlugs=[])
    result = find_orphaned_stock([good, bad], CHANNEL, legacy_mode=False)
    assert result == [{
        "variantId": "UHJvZHVjdFZhcmlhbnQ6Mg==",
        "warehouseId": "V2FyZWhvdXNlOjE=",
        "reason": "warehouse not linked to channel",
    }]


def test_to_variant_stock_records_flattens_graphql_shape():
    variant_data = {
        "stocks": [
            {
                "quantity": 5,
                "warehouse": {
                    "id": "V2FyZWhvdXNlOjE=",
                    "name": "Main warehouse",
                    "channels": [{"slug": "default-channel"}],
                    "shippingZones": {
                        "edges": [
                            {"node": {"id": "Z1", "channels": [{"slug": "default-channel"}], "countries": [{"code": "US"}]}}
                        ]
                    },
                },
            }
        ]
    }
    records = to_variant_stock_records("UHJvZHVjdFZhcmlhbnQ6MQ==", variant_data)
    assert records == [{
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "warehouseId": "V2FyZWhvdXNlOjE=",
        "quantity": 5,
        "warehouseChannelSlugs": ["default-channel"],
        "warehouseZones": [{"id": "Z1", "channelSlugs": ["default-channel"], "countries": ["US"]}],
    }]
