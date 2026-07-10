from flag_variant_pricing_gaps import classify_variant_pricing

ACTIVE = ["default-channel", "eu-channel"]


def variant(**over):
    base = {
        "id": "gid://saleor/ProductVariant/1",
        "sku": "SKU-1",
        "channelListings": [
            {"channelSlug": "default-channel", "isPublished": True, "price": {"amount": 19.99, "currency": "USD"}},
        ],
    }
    base.update(over)
    return base


def test_priced_when_active_listing_has_price():
    assert classify_variant_pricing(variant(), ACTIVE) == "PRICED"


def test_unpriced_null_price_when_listing_price_is_none():
    v = variant(channelListings=[
        {"channelSlug": "default-channel", "isPublished": True, "price": None},
    ])
    assert classify_variant_pricing(v, ACTIVE) == "UNPRICED_NULL_PRICE"


def test_not_sold_in_active_channel_when_no_relevant_listing():
    v = variant(channelListings=[
        {"channelSlug": "inactive-channel", "isPublished": True, "price": {"amount": 5, "currency": "USD"}},
    ])
    assert classify_variant_pricing(v, ACTIVE) == "NOT_SOLD_IN_ACTIVE_CHANNEL"


def test_not_sold_in_active_channel_when_no_listings_at_all():
    v = variant(channelListings=[])
    assert classify_variant_pricing(v, ACTIVE) == "NOT_SOLD_IN_ACTIVE_CHANNEL"


def test_priced_when_multiple_active_channels_all_priced():
    v = variant(channelListings=[
        {"channelSlug": "default-channel", "isPublished": True, "price": {"amount": 19.99, "currency": "USD"}},
        {"channelSlug": "eu-channel", "isPublished": True, "price": {"amount": 18.5, "currency": "EUR"}},
    ])
    assert classify_variant_pricing(v, ACTIVE) == "PRICED"


def test_unpriced_null_price_wins_over_priced_channel():
    v = variant(channelListings=[
        {"channelSlug": "default-channel", "isPublished": True, "price": {"amount": 19.99, "currency": "USD"}},
        {"channelSlug": "eu-channel", "isPublished": True, "price": None},
    ])
    assert classify_variant_pricing(v, ACTIVE) == "UNPRICED_NULL_PRICE"


def test_channel_not_in_active_list_is_ignored():
    v = variant(channelListings=[
        {"channelSlug": "default-channel", "isPublished": True, "price": {"amount": 19.99, "currency": "USD"}},
        {"channelSlug": "retired-channel", "isPublished": True, "price": None},
    ])
    assert classify_variant_pricing(v, ACTIVE) == "PRICED"
