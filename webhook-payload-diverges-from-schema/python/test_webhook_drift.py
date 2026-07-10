from detect_webhook_payload_drift import diff_payload_against_schema, extract_selection_fields


def test_no_drift_when_payload_matches_expected_fields():
    payload = {"id": "gid://saleor/Product/1", "name": "Mug", "slug": "mug"}
    result = diff_payload_against_schema(payload, ["id", "name", "slug"])
    assert result == {"missingInPayload": [], "unexpectedInPayload": []}


def test_detects_renamed_field_as_missing():
    # query expects "category", payload was produced by an older query that
    # only ever had "categoryId", simulating a field rename drift
    payload = {"id": "1", "name": "Mug", "categoryId": "9"}
    result = diff_payload_against_schema(payload, ["id", "name", "category"])
    assert result["missingInPayload"] == ["category"]
    assert result["unexpectedInPayload"] == ["categoryId"]


def test_detects_deprecated_field_returning_null():
    payload = {"id": "1", "name": "Mug", "chargeTaxes": None}
    result = diff_payload_against_schema(payload, ["id", "name", "chargeTaxes"])
    assert result["missingInPayload"] == ["chargeTaxes"]
    assert result["unexpectedInPayload"] == []


def test_detects_extra_field_from_newer_saleor_version():
    payload = {"id": "1", "name": "Mug", "slug": "mug", "externalReference": "ext-1"}
    result = diff_payload_against_schema(payload, ["id", "name", "slug"])
    assert result["missingInPayload"] == []
    assert result["unexpectedInPayload"] == ["externalReference"]


def test_non_dict_payload_flags_all_fields_missing():
    result = diff_payload_against_schema(None, ["id", "name"])
    assert result == {"missingInPayload": ["id", "name"], "unexpectedInPayload": []}


def test_nested_path_is_used_in_labels():
    payload = {"id": "1"}
    result = diff_payload_against_schema(payload, ["id", "name"], path="product")
    assert result["missingInPayload"] == ["product.name"]
    assert result["unexpectedInPayload"] == []


def test_extract_selection_fields_reads_top_level_only():
    fragment = "on ProductUpdated { product { id name category { id } } }"
    assert extract_selection_fields(fragment) == ["product"]
