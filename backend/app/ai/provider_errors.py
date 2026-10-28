"""Actionable provider errors without copying SDK payloads, prompts or credentials."""
from __future__ import annotations

from functools import wraps


class ProviderFailure(RuntimeError):
    def __init__(self, code: str, message: str, hint: str, http_status: int = 502):
        self.code, self.message, self.hint, self.http_status = code, message, hint, http_status
        super().__init__(f"{message} {hint}")


def failure_for_status(status: int | None, *, invalid_key: bool = False) -> ProviderFailure:
    if status == 401 or invalid_key:
        return ProviderFailure("invalid_api_key", "AI sağlayıcısı API anahtarını kabul etmedi.",
                               "Sunucudaki GEMINI_API_KEY değerini kontrol edip backend sunucusunu yeniden başlatın.", 422)
    if status == 403:
        return ProviderFailure("provider_permission_denied", "AI sağlayıcısı bu işlem için erişim vermedi.",
                               "Anahtarın proje, bölge ve model izinlerini sağlayıcı hesabında kontrol edin.", 422)
    if status == 404:
        return ProviderFailure("model_unavailable", "AI sağlayıcısındaki modele veya istenen kaynağa erişilemiyor.",
                               "Model kimliğini ve kaynak erişimini kontrol edip hesabınızın erişebildiği bir model seçin.", 422)
    if status == 429:
        return ProviderFailure("provider_quota", "AI sağlayıcısının kota veya istek sınırına ulaşıldı.",
                               "Kota ve faturalandırmayı kontrol edin; yeniden denemeden önce bekleyin. Başlamış bir isteği tekrarlamak ek ücret doğurabilir.", 429)
    if status == 400:
        return ProviderFailure("provider_invalid_request", "AI sağlayıcısı üretim ayarlarını kabul etmedi.",
                               "Seçili modelin süre, format ve içerik kurallarını kontrol edin.", 422)
    return ProviderFailure("provider_unavailable", "AI sağlayıcısı isteği tamamlayamadı.",
                           "Bağlantıyı ve sağlayıcı durumunu kontrol edin. İstek başlamış olabilir; yeniden üretim ek ücret doğurabilir.")


def normalize_provider_errors(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ProviderFailure:
            raise
        except Exception as exc:
            from google.genai.errors import APIError
            import httpx
            if isinstance(exc, APIError):
                details = exc.details if isinstance(exc.details, dict) else {}
                error = details.get("error", details)
                reasons = error.get("details", []) if isinstance(error, dict) else []
                reasons = reasons if isinstance(reasons, list) else []
                invalid = any(isinstance(item, dict) and item.get("reason") in ("API_KEY_INVALID", "API_KEY_EXPIRED") for item in reasons)
                raise failure_for_status(exc.code, invalid_key=invalid) from None
            if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
                raise failure_for_status(None) from None
            raise  # Local validation/render errors retain their existing semantics.
    return wrapped
