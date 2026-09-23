"""Provider error taxonomy: what retries can fix, and what it cannot."""

import pytest

from minisweagent.models.errors import ABORT_STATUSES, ProviderAbortError, ProviderError, classify_status


@pytest.mark.parametrize("status", sorted(ABORT_STATUSES))
def test_permanent_client_errors_abort(status):
    error = classify_status(status, "the provider said no", "https://api.example/v1")
    assert isinstance(error, ProviderAbortError)
    assert error.status == status


def test_unpaid_balance_aborts_with_a_hint():
    """DeepSeek reports an empty balance as 402: retrying 10x would just burn the clock."""
    error = classify_status(402, "Insufficient Balance", "https://api.deepseek.com/v1")
    assert isinstance(error, ProviderAbortError)
    assert "Top up your balance" in str(error)


@pytest.mark.parametrize("status", [408, 409, 429, 500, 502, 503])
def test_transient_errors_stay_retryable(status):
    error = classify_status(status, "try later", "https://api.example/v1")
    assert type(error) is ProviderError
    assert not isinstance(error, ProviderAbortError)


def test_rate_limits_misreported_as_4xx_stay_retryable():
    error = classify_status(400, "Rate limit reached, slow down", "https://api.example/v1")
    assert not isinstance(error, ProviderAbortError)


def test_auth_statuses_carry_the_key_hint():
    for status in (401, 403):
        assert "mini-extra config set KEY VALUE" in str(classify_status(status, "no", "http://x"))
