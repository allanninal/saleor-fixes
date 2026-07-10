from flag_gift_card_blocks import classify_gift_card_order_block


def order(**over):
    base = {
        "status": "FULFILLED",
        "giftCards": [{"id": "R2lmdENhcmQ6MQ==", "last4CodeChars": "9F2K"}],
        "lines": [{"id": "T3JkZXJMaW5lOjE=", "isGift": True, "quantity": 1}],
        "fulfillments": [{"id": "RnVsZmlsbG1lbnQ6MQ==", "status": "FULFILLED"}],
    }
    base.update(over)
    return base


def test_blocked_with_cannot_cancel_fulfillment_when_gift_card_and_fulfilled():
    result = classify_gift_card_order_block(order())
    assert result["blocked"] is True
    assert result["blockingCode"] == "CANNOT_CANCEL_FULFILLMENT"


def test_blocked_with_non_removable_gift_line_when_no_blocking_fulfillment():
    result = classify_gift_card_order_block(order(giftCards=[], fulfillments=[]))
    assert result["blocked"] is True
    assert result["blockingCode"] == "NON_REMOVABLE_GIFT_LINE"


def test_partially_fulfilled_still_blocks_cancel():
    result = classify_gift_card_order_block(order(fulfillments=[{"id": "Zg==", "status": "PARTIALLY_FULFILLED"}]))
    assert result["blockingCode"] == "CANNOT_CANCEL_FULFILLMENT"


def test_waiting_for_approval_still_blocks_cancel():
    result = classify_gift_card_order_block(order(fulfillments=[{"id": "Zg==", "status": "WAITING_FOR_APPROVAL"}]))
    assert result["blockingCode"] == "CANNOT_CANCEL_FULFILLMENT"


def test_not_blocked_when_no_gift_cards_and_no_gift_lines():
    result = classify_gift_card_order_block(order(giftCards=[], lines=[{"id": "L2", "isGift": False, "quantity": 1}]))
    assert result == {"blocked": False, "blockingCode": None, "reason": "No gift card lifecycle block found."}


def test_not_blocked_when_fulfillment_is_cancelled():
    result = classify_gift_card_order_block(
        order(lines=[{"id": "L2", "isGift": False, "quantity": 1}], fulfillments=[{"id": "Zg==", "status": "CANCELED"}])
    )
    assert result["blocked"] is False


def test_gift_card_present_but_only_unfulfilled_fulfillment_falls_through_to_line_check():
    result = classify_gift_card_order_block(order(fulfillments=[{"id": "Zg==", "status": "UNFULFILLED"}]))
    assert result["blockingCode"] == "NON_REMOVABLE_GIFT_LINE"


def test_no_gift_cards_key_and_no_lines_key_defaults_safely():
    result = classify_gift_card_order_block({"status": "UNFULFILLED"})
    assert result == {"blocked": False, "blockingCode": None, "reason": "No gift card lifecycle block found."}
