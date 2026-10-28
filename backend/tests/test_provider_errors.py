from __future__ import annotations

import pytest
import httpx
from google.genai.errors import ClientError, ServerError

from app.ai.provider_errors import ProviderFailure, normalize_provider_errors


@pytest.mark.parametrize("status,reason,code", [(400, "API_KEY_INVALID", "invalid_api_key"),
    (401, None, "invalid_api_key"), (403, None, "provider_permission_denied"),
    (404, None, "model_unavailable"), (429, None, "provider_quota"),
    (400, None, "provider_invalid_request"), (503, None, "provider_unavailable")])
def test_sdk_failures_are_actionable_sanitized_and_never_retried(status, reason, code):
    calls = []
    @normalize_provider_errors
    def fail():
        calls.append(True)
        cls = ServerError if status >= 500 else ClientError
        raise cls(status, {"error": {"message": "PRIVATE_PROMPT_AND_API_KEY", "details": [{"reason": reason}]}})
    with pytest.raises(ProviderFailure) as captured:
        fail()
    assert captured.value.code == code
    assert captured.value.hint
    assert "PRIVATE_PROMPT_AND_API_KEY" not in str(captured.value)
    assert len(calls) == 1


def test_transport_failure_warns_about_ambiguous_cost_and_local_validation_is_unchanged():
    @normalize_provider_errors
    def timeout():
        raise httpx.ReadTimeout("private request URL")
    with pytest.raises(ProviderFailure, match="ek ücret") as captured:
        timeout()
    assert "private" not in str(captured.value)
    @normalize_provider_errors
    def invalid():
        raise ValueError("local validation")
    with pytest.raises(ValueError, match="local validation"):
        invalid()
