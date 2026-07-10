from retry_stale_failed_deliveries import decide_stale_failed_retries

NOW = "2026-07-10T02:00:00Z"  # 2 hours after the attempts below


def attempt(**over):
    base = {"createdAt": "2026-07-10T00:00:00Z", "responseStatusCode": 503}
    base.update(over)
    return base


def delivery(**over):
    base = {
        "id": "gid://saleor/EventDelivery/1",
        "status": "FAILED",
        "createdAt": "2026-07-09T23:55:00Z",
        "attempts": [attempt() for _ in range(5)],
    }
    base.update(over)
    return base


def test_skip_when_not_failed():
    result = decide_stale_failed_retries([delivery(status="SUCCESS")], NOW)
    assert result[0]["action"] == "SKIP"
    assert result[0]["reason"] == "not-failed"


def test_skip_when_still_within_retry_window():
    d = delivery(attempts=[attempt(createdAt="2026-07-10T01:59:00Z")])
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "SKIP"
    assert result[0]["reason"] == "still-within-retry-window"


def test_retry_when_stale_and_transient_error():
    # A 429 (rate limited) is not treated as a dead endpoint, unlike a 5xx.
    d = delivery(attempts=[attempt(responseStatusCode=429) for _ in range(5)])
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "RETRY"
    assert result[0]["reason"] == "stale-failed-past-retry-limit-transient-error"


def test_retry_when_mixed_status_codes_not_all_dead():
    attempts = [attempt(responseStatusCode=200), *[attempt(responseStatusCode=503) for _ in range(4)]]
    d = delivery(attempts=attempts)
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "RETRY"


def test_flag_dead_endpoint_when_all_recent_attempts_are_5xx():
    d = delivery(attempts=[attempt(responseStatusCode=500) for _ in range(5)])
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "FLAG_DEAD_ENDPOINT"
    assert result[0]["reason"] == "endpoint-repeatedly-unreachable"


def test_flag_dead_endpoint_when_attempts_have_no_response_code():
    d = delivery(attempts=[attempt(responseStatusCode=None) for _ in range(5)])
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "FLAG_DEAD_ENDPOINT"


def test_skip_when_recently_exhausted_but_not_yet_stale():
    d = delivery(attempts=[attempt(createdAt="2026-07-10T01:45:00Z") for _ in range(5)])
    result = decide_stale_failed_retries([d], NOW, {"staleAfterMs": 3600000})
    assert result[0]["action"] == "SKIP"
    assert result[0]["reason"] == "recently-exhausted-wait-for-staleness-window"


def test_skip_when_fewer_than_max_retries_and_not_stale():
    d = delivery(attempts=[attempt(createdAt="2026-07-10T01:59:30Z")])
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "SKIP"
    assert result[0]["reason"] == "still-within-retry-window"


def test_uses_delivery_created_at_when_no_attempts():
    # No attempts means attemptCount (0) < maxRetries, so it has not exhausted
    # Saleor's retry budget yet, even though the delivery itself is old.
    d = delivery(attempts=[], createdAt="2026-07-10T00:00:00Z")
    result = decide_stale_failed_retries([d], NOW)
    assert result[0]["action"] == "SKIP"
    assert result[0]["reason"] == "recently-exhausted-wait-for-staleness-window"


def test_exactly_at_max_retries_and_exactly_stale_boundary():
    d = delivery(attempts=[attempt(createdAt="2026-07-10T01:00:00Z", responseStatusCode=429) for _ in range(5)])
    result = decide_stale_failed_retries([d], NOW, {"staleAfterMs": 3600000})
    assert result[0]["action"] == "RETRY"
