"""Explicit, metadata-only provider checks. Never generate content or expose secrets."""
from __future__ import annotations

import copy
import threading
from datetime import datetime, timezone

from ..config import Settings
from . import catalog

_check_lock = threading.Lock()


class CheckInProgress(RuntimeError):
    pass


def configuration(settings: Settings) -> dict:
    has_key = bool(settings.gemini_api_key.strip())
    status = "test" if settings.is_mock else "unchecked" if has_key else "missing_key"
    messages = {
        "test": "Test sağlayıcısı etkin; gerçek AI bağlantısı kontrol edilmedi.",
        "unchecked": "Anahtar tanımlı; sağlayıcı ve model erişimi henüz kontrol edilmedi.",
        "missing_key": "GEMINI_API_KEY tanımlı değil; gerçek AI bağlantısı kurulamaz.",
    }
    return {
        "status": status, "key_configured": has_key, "mode": "test" if settings.is_mock else "real",
        "can_check": has_key and not settings.is_mock, "checked_at": None,
        "message": messages[status],
        "models": [
            {"role": role, "id": model, "status": "unchecked", "message": "Henüz kontrol edilmedi.",
             "catalog_status": catalog.video_model_status(model) if role == "video" else None}
            for role, model in (("text", settings.gemini_text_model),
                                ("transcription", settings.gemini_transcribe_model), ("video", settings.veo_model))
        ],
        "scope_note": "Bu kontrol yalnızca model bilgisine erişimi doğrular. Üretim yetkisi, faturalandırma, kota ve içerik üretiminin başarılı olacağı garanti edilmez.",
    }


def _client(settings: Settings):
    from google import genai
    from google.genai import types

    # The diagnostics client has bounded reads and no automatic HTTP retries.
    return genai.Client(api_key=settings.gemini_api_key, http_options=types.HttpOptions(
        timeout=7000, retry_options=types.HttpRetryOptions(attempts=1)))


def _failure(exc: Exception) -> dict:
    # Provider exceptions may contain request URLs or credentials. Do not return/log them.
    code = getattr(exc, "code", None)
    if code in (401, 403):
        return {"status": "unavailable", "reason": "access_denied", "message": "Sağlayıcı erişimi reddetti; anahtar ve hesap izinlerini kontrol edin."}
    if code == 404:
        return {"status": "unavailable", "reason": "model_unavailable", "message": "Bu modelin bilgisine erişilemedi; model kimliğini ve hesap erişimini kontrol edin."}
    if code == 429:
        return {"status": "unknown", "reason": "rate_limited", "message": "Sağlayıcı kontrol sınırına ulaşıldı; daha sonra yeniden deneyin."}
    if code == 400:
        return {"status": "unavailable", "reason": "request_rejected", "message": "Sağlayıcı kontrol isteğini reddetti; anahtar ve model yapılandırmasını kontrol edin."}
    return {"status": "unknown", "reason": "check_failed", "message": "Bağlantı kontrolü tamamlanamadı; ağ bağlantısını kontrol edip yeniden deneyin."}


def check(settings: Settings) -> dict:
    report = configuration(settings)
    if not report["can_check"]:
        return report  # Local/test checks must not instantiate any provider client.
    if not _check_lock.acquire(blocking=False):
        raise CheckInProgress("Bağlantı kontrolü zaten sürüyor; bitmesini bekleyin.")
    try:
        outcomes: dict[str, dict] = {}
        try:
            with _client(settings) as client:
                stop = False
                for item in report["models"]:
                    model = item["id"]
                    if model in outcomes:
                        continue  # Text and transcription commonly use the same model.
                    if stop:
                        outcomes[model] = {"status": "unknown", "reason": "not_checked",
                                           "message": "Önceki bağlantı hatası nedeniyle kontrol edilmedi."}
                        continue
                    try:
                        info = client.models.get(model=model)  # Metadata GET only.
                        if not getattr(info, "name", None):
                            raise ValueError("Missing model metadata")
                        outcomes[model] = {"status": "available", "reason": None,
                                           "message": "Model bilgisine erişildi; içerik üretimi yapılmadı."}
                    except Exception as exc:
                        outcomes[model] = _failure(exc)
                        stop = outcomes[model]["reason"] != "model_unavailable"
        except Exception as exc:
            # Client initialization/transport teardown errors also fail closed.
            failure = _failure(exc)
            outcomes = {item["id"]: copy.deepcopy(failure) for item in report["models"]}
        for item in report["models"]:
            item.update(outcomes[item["id"]])
        available = sum(item["status"] == "available" for item in report["models"])
        report["status"] = "checked" if available == len(report["models"]) else "partial" if available else "error"
        report["message"] = {
            "checked": "Yapılandırılmış modellerin bilgilerine erişildi. Üretim yapılmadı.",
            "partial": "Bazı modellerin bilgilerine erişildi; diğer modeller doğrulanamadı.",
            "error": "Bağlantı doğrulanamadı; model satırlarındaki açıklamaları inceleyin.",
        }[report["status"]]
        report["checked_at"] = datetime.now(timezone.utc).isoformat()
        return report
    finally:
        _check_lock.release()
