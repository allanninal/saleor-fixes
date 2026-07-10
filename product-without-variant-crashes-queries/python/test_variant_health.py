from flag_variantless_products import classify_variant_health


def product(**over):
    base = {
        "id": "UHJvZHVjdDox",
        "variants": [{"id": "UHJvZHVjdFZhcmlhbnQ6MQ=="}],
        "channelListings": [{"channel": {"slug": "default-channel"}, "isPublished": True}],
    }
    base.update(over)
    return base


def test_ok_when_it_has_a_variant():
    result = classify_variant_health(product())
    assert result == {"status": "OK", "affectedChannels": []}


def test_no_variants_published_when_a_channel_is_published():
    result = classify_variant_health(product(variants=[]))
    assert result["status"] == "NO_VARIANTS_PUBLISHED"
    assert result["affectedChannels"] == ["default-channel"]


def test_no_variants_unpublished_when_no_channel_is_published():
    listings = [{"channel": {"slug": "default-channel"}, "isPublished": False}]
    result = classify_variant_health(product(variants=[], channelListings=listings))
    assert result == {"status": "NO_VARIANTS_UNPUBLISHED", "affectedChannels": []}


def test_multiple_published_channels_are_all_reported():
    listings = [
        {"channel": {"slug": "default-channel"}, "isPublished": True},
        {"channel": {"slug": "pos"}, "isPublished": True},
        {"channel": {"slug": "b2b"}, "isPublished": False},
    ]
    result = classify_variant_health(product(variants=[], channelListings=listings))
    assert result["status"] == "NO_VARIANTS_PUBLISHED"
    assert result["affectedChannels"] == ["default-channel", "pos"]


def test_no_channel_listings_at_all_is_unpublished():
    result = classify_variant_health(product(variants=[], channelListings=[]))
    assert result == {"status": "NO_VARIANTS_UNPUBLISHED", "affectedChannels": []}


def test_missing_variants_key_treated_as_empty():
    result = classify_variant_health({"id": "UHJvZHVjdDoy", "channelListings": []})
    assert result == {"status": "NO_VARIANTS_UNPUBLISHED", "affectedChannels": []}
