from find_unlinked_guest_orders import find_unlinked_guest_orders


def order(**over):
    base = {"id": "gid://saleor/Order/1", "number": "1001", "userEmail": "jane@example.com", "user": None}
    base.update(over)
    return base


def customer(**over):
    base = {"id": "gid://saleor/User/1", "email": "jane@example.com"}
    base.update(over)
    return base


def test_flags_guest_order_matching_a_customer_email():
    result = find_unlinked_guest_orders([order()], [customer()])
    assert result == [{
        "orderId": "gid://saleor/Order/1",
        "orderNumber": "1001",
        "userEmail": "jane@example.com",
        "matchedCustomerId": "gid://saleor/User/1",
    }]


def test_skips_order_already_linked_to_a_user():
    linked = order(user={"id": "gid://saleor/User/1"})
    assert find_unlinked_guest_orders([linked], [customer()]) == []


def test_skips_order_with_no_matching_customer():
    assert find_unlinked_guest_orders([order(userEmail="stranger@example.com")], [customer()]) == []


def test_skips_order_with_no_email():
    assert find_unlinked_guest_orders([order(userEmail=None)], [customer()]) == []


def test_skips_order_with_blank_email():
    assert find_unlinked_guest_orders([order(userEmail="   ")], [customer()]) == []


def test_matches_case_insensitively_and_trims_whitespace():
    result = find_unlinked_guest_orders(
        [order(userEmail="  Jane@Example.com  ")],
        [customer(email="jane@example.com")],
    )
    assert len(result) == 1
    assert result[0]["matchedCustomerId"] == "gid://saleor/User/1"


def test_multiple_orders_only_flags_the_unlinked_matches():
    orders = [
        order(id="o1", number="1001"),
        order(id="o2", number="1002", user={"id": "gid://saleor/User/9"}),
        order(id="o3", number="1003", userEmail="nomatch@example.com"),
    ]
    result = find_unlinked_guest_orders(orders, [customer()])
    assert [row["orderId"] for row in result] == ["o1"]


def test_no_customers_means_no_flags():
    assert find_unlinked_guest_orders([order()], []) == []


def test_customer_with_blank_email_is_never_a_match_key():
    result = find_unlinked_guest_orders([order(userEmail="")], [customer(email="")])
    assert result == []
