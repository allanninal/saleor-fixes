from find_missing_listings import find_missing_channel_listings

V1 = "gid://saleor/ProductVariant/1"
V2 = "gid://saleor/ProductVariant/2"
V3 = "gid://saleor/ProductVariant/3"


def test_no_gap_when_variant_has_all_channels():
    variant_channel_listings = {V1: ["default-channel", "b2b"]}
    result = find_missing_channel_listings([V1], variant_channel_listings, ["default-channel", "b2b"])
    assert result == {}


def test_gap_when_variant_missing_one_channel():
    variant_channel_listings = {V1: ["default-channel"]}
    result = find_missing_channel_listings([V1], variant_channel_listings, ["default-channel", "b2b"])
    assert result == {V1: ["b2b"]}


def test_gap_when_variant_has_no_listings_at_all():
    variant_channel_listings = {}
    result = find_missing_channel_listings([V2], variant_channel_listings, ["default-channel"])
    assert result == {V2: ["default-channel"]}


def test_missing_slugs_are_sorted():
    variant_channel_listings = {V1: []}
    result = find_missing_channel_listings([V1], variant_channel_listings, ["b2b", "default-channel", "aa-region"])
    assert result[V1] == ["aa-region", "b2b", "default-channel"]


def test_multiple_variants_get_independent_results():
    variant_channel_listings = {V1: ["default-channel"], V2: ["default-channel", "b2b"]}
    result = find_missing_channel_listings([V1, V2, V3], variant_channel_listings, ["default-channel", "b2b"])
    assert result == {V1: ["b2b"], V3: ["b2b", "default-channel"]}


def test_only_flags_channels_the_product_is_actually_listed_in():
    variant_channel_listings = {V1: ["default-channel"]}
    result = find_missing_channel_listings([V1], variant_channel_listings, ["default-channel"])
    assert result == {}


def test_variant_not_in_imported_ids_is_ignored():
    variant_channel_listings = {V1: [], V2: []}
    result = find_missing_channel_listings([V1], variant_channel_listings, ["default-channel"])
    assert V2 not in result
