from find_orphaned_warehouse_zone_links import (
    find_orphaned_warehouse_zone_links,
    build_warehouse_channel_map,
)

WH_1 = {"id": "V2FyZWhvdXNlOjE=", "name": "Main warehouse"}
WH_2 = {"id": "V2FyZWhvdXNlOjI=", "name": "Overflow warehouse"}


def zone(**over):
    base = {
        "id": "U2hpcHBpbmdab25lOjE=",
        "name": "EU zone",
        "channels": [{"id": "Q2hhbm5lbDox", "slug": "default-channel"}],
        "warehouses": [WH_1],
    }
    base.update(over)
    return base


def test_shared_channel_is_not_flagged():
    warehouse_channel_map = {WH_1["id"]: {"default-channel"}}
    assert find_orphaned_warehouse_zone_links([zone()], warehouse_channel_map) == []


def test_no_shared_channel_is_flagged():
    warehouse_channel_map = {WH_1["id"]: {"other-channel"}}
    result = find_orphaned_warehouse_zone_links([zone()], warehouse_channel_map)
    assert result == [{
        "zoneId": "U2hpcHBpbmdab25lOjE=",
        "zoneName": "EU zone",
        "warehouseId": WH_1["id"],
        "warehouseName": "Main warehouse",
        "zoneChannelSlugs": ["default-channel"],
    }]


def test_warehouse_missing_from_map_is_flagged():
    result = find_orphaned_warehouse_zone_links([zone()], {})
    assert result == [{
        "zoneId": "U2hpcHBpbmdab25lOjE=",
        "zoneName": "EU zone",
        "warehouseId": WH_1["id"],
        "warehouseName": "Main warehouse",
        "zoneChannelSlugs": ["default-channel"],
    }]


def test_zone_with_no_channels_flags_every_warehouse():
    z = zone(channels=[], warehouses=[WH_1, WH_2])
    warehouse_channel_map = {WH_1["id"]: {"default-channel"}, WH_2["id"]: {"default-channel"}}
    result = find_orphaned_warehouse_zone_links([z], warehouse_channel_map)
    assert {r["warehouseId"] for r in result} == {WH_1["id"], WH_2["id"]}


def test_only_the_orphaned_warehouse_is_flagged_among_several():
    z = zone(warehouses=[WH_1, WH_2])
    warehouse_channel_map = {
        WH_1["id"]: {"default-channel"},
        WH_2["id"]: {"wholesale-channel"},
    }
    result = find_orphaned_warehouse_zone_links([z], warehouse_channel_map)
    assert [r["warehouseId"] for r in result] == [WH_2["id"]]


def test_build_warehouse_channel_map_inverts_channel_warehouses():
    channels = [
        {"slug": "default-channel", "warehouses": {"edges": [{"node": {"id": WH_1["id"]}}]}},
        {"slug": "wholesale-channel", "warehouses": {"edges": [
            {"node": {"id": WH_1["id"]}}, {"node": {"id": WH_2["id"]}},
        ]}},
    ]
    result = build_warehouse_channel_map(channels)
    assert result == {
        WH_1["id"]: {"default-channel", "wholesale-channel"},
        WH_2["id"]: {"wholesale-channel"},
    }
