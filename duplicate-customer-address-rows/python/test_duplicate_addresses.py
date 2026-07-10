from find_duplicate_customer_addresses import (
    address_key,
    find_duplicate_addresses,
)


def address(**over):
    base = {
        "id": "gid://saleor/Address/1",
        "firstName": "Jane",
        "lastName": "Doe",
        "streetAddress1": "12 Oak Street",
        "streetAddress2": "",
        "city": "Portland",
        "postalCode": "97201",
        "country": {"code": "US"},
        "isDefaultShippingAddress": False,
    }
    base.update(over)
    return base


def customer(addresses, **over):
    base = {"id": "gid://saleor/User/1", "email": "jane@example.com", "addresses": addresses}
    base.update(over)
    return base


def test_key_is_case_and_whitespace_insensitive():
    a = address(streetAddress1="12 Oak Street", city="Portland")
    b = address(id="gid://saleor/Address/2", streetAddress1="  12  OAK street ", city="portland ")
    assert address_key(a) == address_key(b)


def test_flags_two_identical_addresses():
    a1 = address(id="a1")
    a2 = address(id="a2")
    result = find_duplicate_addresses([customer([a1, a2])])
    assert len(result) == 1
    assert result[0]["keepId"] == "a1"
    assert result[0]["duplicateIds"] == ["a2"]


def test_single_address_is_never_a_duplicate():
    assert find_duplicate_addresses([customer([address(id="a1")])]) == []


def test_different_addresses_are_not_grouped():
    a1 = address(id="a1", streetAddress1="12 Oak Street")
    a2 = address(id="a2", streetAddress1="99 Elm Avenue")
    assert find_duplicate_addresses([customer([a1, a2])]) == []


def test_default_shipping_address_is_kept():
    a1 = address(id="a1")
    a2 = address(id="a2", isDefaultShippingAddress=True)
    a3 = address(id="a3")
    result = find_duplicate_addresses([customer([a1, a2, a3])])
    assert result[0]["keepId"] == "a2"
    assert sorted(result[0]["duplicateIds"]) == ["a1", "a3"]


def test_first_address_is_kept_when_no_default():
    a1 = address(id="a1")
    a2 = address(id="a2")
    a3 = address(id="a3")
    result = find_duplicate_addresses([customer([a1, a2, a3])])
    assert result[0]["keepId"] == "a1"
    assert result[0]["duplicateIds"] == ["a2", "a3"]


def test_street_address_2_participates_in_the_key():
    a1 = address(id="a1", streetAddress2="Apt 4")
    a2 = address(id="a2", streetAddress2="Apt 9")
    assert find_duplicate_addresses([customer([a1, a2])]) == []


def test_country_participates_in_the_key():
    a1 = address(id="a1", country={"code": "US"})
    a2 = address(id="a2", country={"code": "CA"})
    assert find_duplicate_addresses([customer([a1, a2])]) == []


def test_two_separate_clusters_for_one_customer():
    a1 = address(id="a1", streetAddress1="12 Oak Street")
    a2 = address(id="a2", streetAddress1="12 Oak Street")
    b1 = address(id="b1", streetAddress1="99 Elm Avenue")
    b2 = address(id="b2", streetAddress1="99 Elm Avenue")
    result = find_duplicate_addresses([customer([a1, a2, b1, b2])])
    assert len(result) == 2
    kept = sorted(cluster["keepId"] for cluster in result)
    assert kept == ["a1", "b1"]


def test_customer_with_no_addresses_is_skipped():
    assert find_duplicate_addresses([customer([])]) == []


def test_missing_country_does_not_crash():
    a1 = address(id="a1", country=None)
    a2 = address(id="a2", country=None)
    result = find_duplicate_addresses([customer([a1, a2])])
    assert result[0]["duplicateIds"] == ["a2"]
