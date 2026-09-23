"""Provider-agnostic HTTP errors for the direct clients (no litellm).

Status classification is shared by every direct client: 408/409/429/5xx and transport
failures are transient and worth retrying (``utils/retry``), anything else in 4xx will
fail the same way again and aborts the run at once.
"""

from typing import Any

#: 4xx statuses that will fail identically on every retry (bad key, unknown model,
#: bad request, payload too large, unprocessable, unpaid -- e.g. DeepSeek's 402
#: "Insufficient Balance") — except rate limits, which are 429s
#: but some gateways misreport as 400/403 with "rate limit" in the body.
ABORT_STATUSES = frozenset({400, 401, 402, 403, 404, 413, 422})


class ProviderError(Exception):
    """An HTTP error from a provider; `status` is None for transport failures."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message


class ProviderAbortError(ProviderError):
    """Errors retrying cannot fix (bad key, unknown model, bad request, context overflow)."""


def classify_status(status: int, detail: Any, base: str) -> ProviderError:
    """Build the error for an HTTP `status` with a provider error `detail`."""
    message = f"HTTP {status} from {base}: {str(detail)[:500]}"
    lowered = str(detail).lower()
    if status in ABORT_STATUSES and "rate limit" not in lowered:
        if status in (401, 403):
            message += " Check the API key (`mini-extra config set KEY VALUE`)."
        if status == 402:
            message += " Top up your balance — retrying will not fix this."
        return ProviderAbortError(message, status)
    return ProviderError(message, status)


# Historical names (kept so existing imports of the openai-compat client keep working).
OpenaiCompatError = ProviderError
OpenaiCompatAbortError = ProviderAbortError
