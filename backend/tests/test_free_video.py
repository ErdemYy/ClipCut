"""Ücretsiz video fallback'i: katalog, yönlendirme ve yerel FFmpeg üretimi."""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("MOCK_AI", "true")

from app import config  # noqa: E402
from app.ai import catalog, connection, free_video, services  # noqa: E402
from app.ffmpeg import probe  # noqa: E402


def real_free_settings(**values):
    return config.Settings(_env_file=None, mock_ai="false", gemini_api_key="test-key",
                           veo_model=free_video.FREE_VIDEO_MODEL, **values)


def test_free_model_is_priced_at_zero_and_preflight_marks_it_free(monkeypatch):
    settings = real_free_settings()
    monkeypatch.setattr(config, "get_settings", lambda: settings)

    model = next(item for item in catalog.video_models() if item.id == free_video.FREE_VIDEO_MODEL)
    assert model.free is True
    assert model.status == "active"
    assert model.price_per_second == 0.0
    assert model.durations == [4, 6, 8]
    assert "Veo çağrılmaz" in (model.note or "")

    estimate = catalog.preflight(
        video_model=free_video.FREE_VIDEO_MODEL, scene_durations=[4, 6],
        planning_scene_count=2, planning_chars=120,
    )
    assert estimate["free_video"] is True
    assert estimate["video_seconds"] == 10
    assert estimate["components"][0]["usd"] == 0.0
    assert any("Ücretsiz mod" in warning for warning in estimate["warnings"])


def test_services_routes_free_model_to_local_provider(monkeypatch, tmp_path):
    settings = real_free_settings()
    monkeypatch.setattr(services, "get_settings", lambda: settings)
    calls = {}

    def fake_generate(prompt, aspect_ratio, duration, out_path, on_progress):
        calls.update(prompt=prompt, aspect_ratio=aspect_ratio, duration=duration, out_path=out_path)
        return {"provider": "free", "model": free_video.FREE_VIDEO_MODEL, "image_source": "picsum"}

    monkeypatch.setattr(free_video, "generate_video", fake_generate)
    out = tmp_path / "scene.mp4"
    meta = services.generate_video("bir sahne", "9:16", 6, None, out, lambda *_: None)
    assert meta == {"provider": "free", "model": free_video.FREE_VIDEO_MODEL, "image_source": "picsum"}
    assert calls == {"prompt": "bir sahne", "aspect_ratio": "9:16", "duration": 6, "out_path": out}


def test_services_forwards_custom_image_to_free_provider(monkeypatch, tmp_path):
    settings = real_free_settings()
    monkeypatch.setattr(services, "get_settings", lambda: settings)
    calls = {}

    def fake_generate(prompt, aspect_ratio, duration, out_path, on_progress, image_path=None):
        calls["image_path"] = image_path
        return {"provider": "free", "model": free_video.FREE_VIDEO_MODEL, "image_source": "custom"}

    monkeypatch.setattr(free_video, "generate_video", fake_generate)
    custom = tmp_path / "custom.jpg"
    meta = services.generate_video("bir sahne", "16:9", 4, None, tmp_path / "scene.mp4", lambda *_: None,
                                   image_path=custom)
    assert meta["image_source"] == "custom"
    assert calls["image_path"] == custom


def test_free_video_uses_custom_image_without_stock_provider(monkeypatch, tmp_path):
    from app.ffmpeg import run_ffmpeg

    source = tmp_path / "custom.jpg"
    run_ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1", str(source)])

    def fail(*_args, **_kwargs):
        raise AssertionError("Özel görsel varken sağlayıcı çağrılmamalı")

    monkeypatch.setattr(free_video, "_download_still", fail)
    out = tmp_path / "scene.mp4"
    meta = free_video.generate_video("özel görsel", "16:9", 2, out, lambda *_: None, image_path=source)

    assert meta == {"provider": "free", "model": free_video.FREE_VIDEO_MODEL, "image_source": "custom"}
    info = probe(out)
    assert info.has_video is True and info.has_audio is False
    assert (info.width, info.height) == (1280, 720)


def test_free_video_local_fallback_renders_requested_duration_and_size(monkeypatch, tmp_path):
    def local_still(prompt: str, width: int, height: int, out_path: Path, on_progress=None) -> str:
        free_video._write_gradient(prompt, width, height, out_path)
        return "local"

    monkeypatch.setattr(free_video, "_download_still", local_still)
    out = tmp_path / "scene.mp4"
    meta = free_video.generate_video("karanlık şehir, neon", "9:16", 2, out, lambda *_: None)

    assert meta == {"provider": "free", "model": free_video.FREE_VIDEO_MODEL, "image_source": "local"}
    info = probe(out)
    assert info.has_video is True
    assert info.has_audio is False
    assert info.width == 720 and info.height == 1280
    assert abs(info.duration - 2.0) < 0.15


def test_stock_download_failure_writes_local_gradient(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "get_settings", lambda: real_free_settings(free_image_provider="auto"))

    class BrokenClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, _url):
            raise RuntimeError("stock service unavailable")

    monkeypatch.setattr(free_video.httpx, "Client", BrokenClient)
    still = tmp_path / "still.jpg"
    source = free_video._download_still("test", 1280, 720, still)
    assert source == "local"
    assert still.exists() and still.stat().st_size > 0


def test_connection_check_skips_provider_for_free_video(monkeypatch):
    settings = real_free_settings()
    queried = []

    class FakeModels:
        def get(self, model):
            queried.append(model)
            return SimpleNamespace(name=model)

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        models = FakeModels()

    monkeypatch.setattr(connection, "_client", lambda _settings: FakeClient())
    report = connection.check(settings)

    assert queried == [settings.gemini_text_model]
    video = next(item for item in report["models"] if item["role"] == "video")
    assert video["status"] == "available"
    assert "Ücretsiz yerel mod" in video["message"]
    assert report["status"] == "checked"


def test_provider_order_prefers_keys_and_falls_back_to_picsum(monkeypatch):
    settings = real_free_settings(free_image_provider="auto", pexels_api_key="p", pixabay_api_key="x")
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    assert free_video._provider_order() == ["pexels", "pixabay", "picsum"]

    monkeypatch.setattr(config, "get_settings", lambda: real_free_settings(free_image_provider="auto"))
    assert free_video._provider_order() == ["picsum"]

    monkeypatch.setattr(config, "get_settings", lambda: real_free_settings(free_image_provider="pexels"))
    assert free_video._provider_order() == ["picsum"]

    monkeypatch.setattr(config, "get_settings", lambda: real_free_settings(free_image_provider="pollinations"))
    assert free_video._provider_order() == ["pollinations", "picsum"]


class FakeResponse:
    def __init__(self, *, payload=None, content=b"", content_type="application/json", status=200):
        self._payload = payload
        self.content = content
        self.status_code = status
        self.headers = {"content-type": content_type}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def test_pexels_search_uses_prompt_keywords_and_downloads_image(monkeypatch):
    calls = []

    class FakeClient:
        def get(self, url, **_kwargs):
            calls.append(url)
            if url == free_video.PEXELS_SEARCH_URL:
                return FakeResponse(payload={"photos": [{"src": {"large": "https://images.example/pexels.jpg"}}]})
            return FakeResponse(content=b"x" * 5000, content_type="image/jpeg")

    image = free_video._pexels_image(FakeClient(), "cinematic mountain landscape at golden hour",
                                     "secret", 1280, 720)
    assert image == b"x" * 5000
    assert calls[0] == free_video.PEXELS_SEARCH_URL
    assert calls[1] == "https://images.example/pexels.jpg"


def test_pixabay_search_uses_landscape_orientation_and_downloads_image():
    calls = []

    class FakeClient:
        def get(self, url, **kwargs):
            calls.append((url, kwargs.get("params") or {}))
            if url == free_video.PIXABAY_SEARCH_URL:
                return FakeResponse(payload={"hits": [{"largeImageURL": "https://images.example/pixabay.jpg"}]})
            return FakeResponse(content=b"y" * 5000, content_type="image/jpeg")

    image = free_video._pixabay_image(FakeClient(), "coffee cup product", "secret", 720, 1280)
    assert image == b"y" * 5000
    assert calls[0][0] == free_video.PIXABAY_SEARCH_URL
    assert calls[0][1]["orientation"] == "vertical"
    assert calls[1][0] == "https://images.example/pixabay.jpg"


def test_provider_failure_falls_through_to_picsum(monkeypatch, tmp_path):
    settings = real_free_settings(free_image_provider="auto", pexels_api_key="secret")
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    calls = []

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url, **_kwargs):
            calls.append(url)
            if url == free_video.PEXELS_SEARCH_URL:
                return FakeResponse(status=401)
            return FakeResponse(content=b"z" * 5000, content_type="image/jpeg")

    monkeypatch.setattr(free_video.httpx, "Client", FakeClient)
    still = tmp_path / "still.jpg"
    source = free_video._download_still("mountain landscape", 1280, 720, still)
    assert source == "picsum"
    assert still.read_bytes() == b"z" * 5000
    assert calls[0] == free_video.PEXELS_SEARCH_URL
    assert free_video.PICSUM_URL.format(seed=f"clipcut-{free_video._seed('mountain landscape')}",
                                        width=1280, height=720) in calls


def test_safe_error_redacts_urls_and_query_keys():
    text = free_video._safe_error(RuntimeError(
        "request failed for https://pixabay.com/api/?key=secret&q=test token=abc"
    ))
    assert "secret" not in text
    assert "abc" not in text
    assert "https://" not in text


def test_pollinations_retries_once_after_free_limit(monkeypatch):
    settings = real_free_settings(free_image_provider="pollinations")
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    monkeypatch.setattr(free_video, "_wait_for_pollinations", lambda *_args, **_kwargs: None)
    responses = [
        FakeResponse(status=402, payload={"error": "FREE_LIMIT"}),
        FakeResponse(content=b"p" * 5000, content_type="image/jpeg"),
    ]

    class FakeClient:
        def get(self, _url, **_kwargs):
            return responses.pop(0)

    image = free_video._pollinations_image(FakeClient(), "neon city", 1280, 720, lambda *_: None)
    assert image == b"p" * 5000
    assert responses == []
