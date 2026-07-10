from fix_missing_channel_listing import (
    find_variants_missing_channel_listing,
    find_sibling_price,
    resolve_price,
)


def variant(**over):
    base = {
        "id": "gid://saleor/ProductVariant/1",
        "sku": "SKU-1",
        "productChannelSlugs": ["default-channel", "us"],
        "variantChannelSlugs": ["default-channel"],
    }
    base.update(over)
    return base


def test_flags_variant_missing_a_channel():
    result = find_variants_missing_channel_listing([variant()])
    assert result == [{"id": "gid://saleor/ProductVariant/1", "sku": "SKU-1", "missingChannels": ["us"]}]


def test_no_flag_when_fully_listed():
    result = find_variants_missing_channel_listing([
        variant(variantChannelSlugs=["default-channel", "us"])
    ])
    assert result == []


def test_no_flag_when_product_has_no_published_channels():
    result = find_variants_missing_channel_listing([
        variant(productChannelSlugs=[], variantChannelSlugs=[])
    ])
    assert result == []


def test_flags_variant_with_zero_channel_listings():
    result = find_variants_missing_channel_listing([
        variant(variantChannelSlugs=[])
    ])
    assert result == [{
        "id": "gid://saleor/ProductVariant/1",
        "sku": "SKU-1",
        "missingChannels": ["default-channel", "us"],
    }]


def test_multiple_variants_mixed_results():
    ok = variant(id="gid://saleor/ProductVariant/2", sku="SKU-2", variantChannelSlugs=["default-channel", "us"])
    bad = variant(id="gid://saleor/ProductVariant/3", sku="SKU-3", variantChannelSlugs=[])
    result = find_variants_missing_channel_listing([ok, bad])
    assert result == [{
        "id": "gid://saleor/ProductVariant/3",
        "sku": "SKU-3",
        "missingChannels": ["default-channel", "us"],
    }]


def test_order_of_missing_channels_follows_product_channels():
    result = find_variants_missing_channel_listing([
        variant(productChannelSlugs=["a", "b", "c"], variantChannelSlugs=["b"])
    ])
    assert result[0]["missingChannels"] == ["a", "c"]


PRODUCT_ID = "gid://saleor/Product/1"


def index_with_sibling_price(amount=19.99, slug="us"):
    return {
        PRODUCT_ID: [
            {"sku": "SKU-1", "channelListingsRaw": [{"channel": {"slug": "default-channel"}, "price": {"amount": 9.99}}]},
            {"sku": "SKU-2", "channelListingsRaw": [{"channel": {"slug": slug}, "price": {"amount": amount}}]},
        ]
    }


def test_find_sibling_price_returns_matching_channel_price():
    index = index_with_sibling_price()
    assert find_sibling_price(PRODUCT_ID, "us", index) == 19.99


def test_find_sibling_price_returns_none_when_no_match():
    index = index_with_sibling_price(slug="eu")
    assert find_sibling_price(PRODUCT_ID, "us", index) is None


def test_find_sibling_price_ignores_listings_without_price():
    index = {PRODUCT_ID: [{"sku": "SKU-1", "channelListingsRaw": [{"channel": {"slug": "us"}, "price": None}]}]}
    assert find_sibling_price(PRODUCT_ID, "us", index) is None


def test_resolve_price_prefers_sibling_over_default():
    index = index_with_sibling_price()
    assert resolve_price(PRODUCT_ID, "us", index, {"us": 5.0}) == 19.99


def test_resolve_price_falls_back_to_default_when_no_sibling():
    index = index_with_sibling_price(slug="eu")
    assert resolve_price(PRODUCT_ID, "us", index, {"us": 5.0}) == 5.0


def test_resolve_price_returns_none_when_no_sibling_and_no_default():
    index = index_with_sibling_price(slug="eu")
    assert resolve_price(PRODUCT_ID, "us", index, {}) is None
