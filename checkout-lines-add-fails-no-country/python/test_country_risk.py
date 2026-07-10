from flag_checkout_country_risk import classify_checkout_country_risk


def channel(**over):
    base = {
        "defaultCountry": "US",
        "warehouses": [{"clickAndCollectOption": "DISABLED"}],
        "shippingZoneCountries": ["US", "CA"],
    }
    base.update(over)
    return base


def test_ok_when_default_country_and_no_pickup_needed():
    result = classify_checkout_country_risk(channel())
    assert result["atRisk"] is False
    assert result["reason"] == "ok"


def test_at_risk_when_no_default_country_and_no_pickup():
    result = classify_checkout_country_risk(channel(defaultCountry=None))
    assert result["atRisk"] is True
    assert result["reason"] == "no_default_country_no_pickup"


def test_ok_when_no_default_country_but_pickup_enabled():
    result = classify_checkout_country_risk(
        channel(defaultCountry=None, warehouses=[{"clickAndCollectOption": "ALL_WAREHOUSES"}])
    )
    assert result["atRisk"] is False
    assert result["reason"] == "ok"


def test_at_risk_when_default_country_outside_shipping_zone():
    result = classify_checkout_country_risk(
        channel(defaultCountry="FR", shippingZoneCountries=["US", "CA"])
    )
    assert result["atRisk"] is True
    assert result["reason"] == "default_country_outside_shipping_zone"


def test_ok_when_default_country_outside_zone_but_pickup_enabled():
    result = classify_checkout_country_risk(
        channel(
            defaultCountry="FR",
            shippingZoneCountries=["US", "CA"],
            warehouses=[{"clickAndCollectOption": "LOCAL_STOCK"}],
        )
    )
    assert result["atRisk"] is False


def test_at_risk_when_no_warehouses_at_all():
    result = classify_checkout_country_risk(channel(defaultCountry=None, warehouses=[]))
    assert result["atRisk"] is True
    assert result["reason"] == "no_default_country_no_pickup"


def test_ok_when_multiple_warehouses_and_one_has_pickup():
    result = classify_checkout_country_risk(
        channel(
            defaultCountry=None,
            warehouses=[
                {"clickAndCollectOption": "DISABLED"},
                {"clickAndCollectOption": "LOCAL_STOCK"},
            ],
        )
    )
    assert result["atRisk"] is False
