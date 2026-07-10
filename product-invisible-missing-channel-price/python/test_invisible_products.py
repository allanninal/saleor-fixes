from find_mispriced_published_listings import find_mispriced_published_listings


def product(**over):
    base = {
        "id": "UHJvZHVjdDox",
        "channelListings": [{"channelSlug": "default-channel", "isPublished": True}],
        "variants": [
            {
                "id": "UHJvZHVjdFZhcmlhbnQ6MQ==",
                "channelListings": [{"channelSlug": "default-channel", "priceAmount": 19.99}],
            }
        ],
    }
    base.update(over)
    return base


def test_fully_priced_published_product_is_not_flagged():
    assert find_mispriced_published_listings([product()]) == []


def test_published_variant_with_no_channel_listing_is_flagged_missing_price():
    p = product(variants=[{"id": "UHJvZHVjdFZhcmlhbnQ6MQ==", "channelListings": []}])
    result = find_mispriced_published_listings([p])
    assert result == [{
        "productId": "UHJvZHVjdDox",
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "channelSlug": "default-channel",
        "reason": "missing_price",
    }]


def test_published_variant_with_null_price_is_flagged_missing_price():
    p = product(variants=[{
        "id": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "channelListings": [{"channelSlug": "default-channel", "priceAmount": None}],
    }])
    result = find_mispriced_published_listings([p])
    assert result[0]["reason"] == "missing_price"


def test_published_variant_with_zero_price_is_flagged_zero_price():
    p = product(variants=[{
        "id": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "channelListings": [{"channelSlug": "default-channel", "priceAmount": 0}],
    }])
    result = find_mispriced_published_listings([p])
    assert result[0]["reason"] == "zero_price"


def test_negative_price_is_flagged_zero_price():
    p = product(variants=[{
        "id": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "channelListings": [{"channelSlug": "default-channel", "priceAmount": -5}],
    }])
    result = find_mispriced_published_listings([p])
    assert result[0]["reason"] == "zero_price"


def test_unpublished_listing_is_never_flagged():
    p = product(channelListings=[{"channelSlug": "default-channel", "isPublished": False}])
    assert find_mispriced_published_listings([p]) == []


def test_only_the_matching_channel_slug_is_checked():
    p = product(
        channelListings=[{"channelSlug": "default-channel", "isPublished": True}],
        variants=[{
            "id": "UHJvZHVjdFZhcmlhbnQ6MQ==",
            "channelListings": [{"channelSlug": "other-channel", "priceAmount": 9.99}],
        }],
    )
    result = find_mispriced_published_listings([p])
    assert result[0]["reason"] == "missing_price"


def test_multiple_channels_only_flags_the_unpriced_one():
    p = product(
        channelListings=[
            {"channelSlug": "default-channel", "isPublished": True},
            {"channelSlug": "eu-channel", "isPublished": True},
        ],
        variants=[{
            "id": "UHJvZHVjdFZhcmlhbnQ6MQ==",
            "channelListings": [
                {"channelSlug": "default-channel", "priceAmount": 19.99},
                {"channelSlug": "eu-channel", "priceAmount": None},
            ],
        }],
    )
    result = find_mispriced_published_listings([p])
    assert result == [{
        "productId": "UHJvZHVjdDox",
        "variantId": "UHJvZHVjdFZhcmlhbnQ6MQ==",
        "channelSlug": "eu-channel",
        "reason": "missing_price",
    }]


def test_no_products_returns_empty_list():
    assert find_mispriced_published_listings([]) == []
