"""Connection diagnostics use metadata fakes only; never production credentials/services."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import config, main
from app.ai import connection


def settings(**values):
    return config.Settings(mock_ai="false", gemini_api_key="not-a-real-key", _env_file=None, **values)


class ProviderError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__("sensitive-provider-detail: not-a-real-key")


def provider(monkeypatch, outcomes=None):
    calls = []
    class Client:
        def __init__(self):
            self.models = SimpleNamespace(get=self.get)
            self.closed = False
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.closed = True
        def get(self, *, model):
            calls.append(model)
            value = (outcomes or {}).get(model)
            if isinstance(value, Exception):
                raise value
            return value or SimpleNamespace(name=f"models/{model}")
    client = Client()
    monkeypatch.setattr(connection, "_client", lambda _: client)
    return calls, client


@pytest.mark.parametrize("mode,key,expected", [("true", "", "test"), ("true", "test-key", "test"),
                                              ("false", "", "missing_key"), ("auto", "", "test")])
def test_local_and_test_modes_never_contact_provider(monkeypatch, mode, key, expected):
    calls = []
    monkeypatch.setattr(connection, "_client", lambda _: calls.append("unexpected"))
    cfg = config.Settings(mock_ai=mode, gemini_api_key=key, _env_file=None)
    report = connection.check(cfg)
    assert report["status"] == expected
    assert report["key_configured"] == bool(key)
    assert report["checked_at"] is None and not report["can_check"]
    assert not calls


def test_configuration_is_local_unverified_and_does_not_expose_key(monkeypatch):
    calls, _ = provider(monkeypatch)
    report = connection.configuration(settings())
    assert report["status"] == "unchecked" and report["key_configured"]
    assert report["can_check"] and report["checked_at"] is None
    assert [row["role"] for row in report["models"]] == ["text", "transcription", "video"]
    assert "not-a-real-key" not in json.dumps(report)
    assert calls == []


def test_explicit_check_deduplicates_models_closes_client_and_only_reads_metadata(monkeypatch):
    calls, client = provider(monkeypatch)
    cfg = settings()
    report = connection.check(cfg)
    assert calls == [cfg.gemini_text_model, cfg.veo_model]
    assert client.closed
    assert report["status"] == "checked" and report["checked_at"]
    assert all(row["status"] == "available" for row in report["models"])
    assert "garanti edilmez" in report["scope_note"]
    assert "not-a-real-key" not in json.dumps(report)


def test_transcription_uses_its_configured_model_and_missing_video_is_partial(monkeypatch):
    cfg = settings(gemini_transcribe_model="transcription-model")
    calls, _ = provider(monkeypatch, {cfg.veo_model: ProviderError(404)})
    report = connection.check(cfg)
    assert len(calls) == 3
    assert report["status"] == "partial"
    assert report["models"][-1]["reason"] == "model_unavailable"


@pytest.mark.parametrize("code,reason", [(400, "request_rejected"), (401, "access_denied"),
                                        (403, "access_denied"), (429, "rate_limited"), (503, "check_failed")])
def test_failed_access_does_not_leak_raw_errors_or_continue_requests(monkeypatch, code, reason):
    cfg = settings()
    calls, _ = provider(monkeypatch, {cfg.gemini_text_model: ProviderError(code)})
    report = connection.check(cfg)
    assert report["status"] == "error" and report["checked_at"]
    assert calls == [cfg.gemini_text_model]
    assert report["models"][0]["reason"] == reason
    assert report["models"][-1]["reason"] == "not_checked"
    assert "sensitive-provider-detail" not in json.dumps(report)
    assert "not-a-real-key" not in json.dumps(report)


def test_timeout_and_malformed_metadata_are_unknown_not_verified(monkeypatch):
    cfg = settings()
    provider(monkeypatch, {cfg.gemini_text_model: TimeoutError("private network url")})
    report = connection.check(cfg)
    assert report["status"] == "error"
    assert report["models"][0]["status"] == "unknown"
    assert "private network" not in json.dumps(report)
    provider(monkeypatch, {cfg.gemini_text_model: SimpleNamespace(name=None)})
    assert connection.check(cfg)["status"] == "error"


def test_client_initialization_failure_is_sanitized_and_lock_released(monkeypatch):
    def fail(_):
        raise ValueError("not-a-real-key")
    monkeypatch.setattr(connection, "_client", fail)
    report = connection.check(settings())
    assert report["status"] == "error"
    assert "not-a-real-key" not in json.dumps(report)
    assert not connection._check_lock.locked()


def test_http_local_read_never_verifies_and_concurrent_check_returns_409(monkeypatch):
    monkeypatch.setattr(main, "settings", settings())
    calls, _ = provider(monkeypatch)
    client = TestClient(main.app)  # No lifespan: no real DB migration or asset worker.
    try:
        response = client.get("/api/ai/connection")
        assert response.status_code == 200 and response.json()["status"] == "unchecked"
        assert calls == []
        with connection._check_lock:
            response = client.post("/api/ai/connection/check")
        assert response.status_code == 409 and calls == []
        response = client.post("/api/ai/connection/check")
        assert response.status_code == 200 and response.json()["status"] == "checked"
        # A page reload must not mistake a previous diagnostic for a permanent guarantee.
        assert client.get("/api/ai/connection").json()["status"] == "unchecked"
    finally:
        client.close()


def test_sdk_diagnostics_client_uses_bounded_gets_without_retry(monkeypatch):
    from google import genai
    captured = {}
    def client(**kwargs):
        captured.update(kwargs)
        return object()
    monkeypatch.setattr(genai, "Client", client)
    connection._client(settings())
    assert captured["http_options"].timeout == 7000
    assert captured["http_options"].retry_options.attempts == 1
