"""Uygulama ayarları. Değerler ortam değişkenlerinden veya backend/.env dosyasından okunur."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    gemini_api_key: str = ""
    # "auto": anahtar yoksa mock, varsa gerçek API. "true"/"false" ile zorlanabilir.
    mock_ai: str = "auto"

    gemini_text_model: str = "gemini-2.5-flash"
    gemini_transcribe_model: str = "gemini-2.5-flash"
    veo_model: str = "veo-3.0-fast-generate-001"
    # Virgülle ayrılmış ek modeller. Yapılandırılmış model her zaman listeye eklenir.
    # Model erişimi sağlayıcı hesabına bağlıdır; seçim garanti değildir.
    text_model_options: str = "gemini-2.5-flash,gemini-2.5-pro"
    veo_model_options: str = "veo-3.0-fast-generate-001,veo-3.0-generate-001"

    storage_dir: Path = ROOT_DIR / "storage"
    assets_dir: Path = ROOT_DIR / "assets"
    # Tamamlanmış istek kimlikleri bu süreden sonra sunucu açılışında temizlenir.
    # 0 veya negatif değer otomatik temizliği kapatır. Bekleyen (belirsiz)
    # rezervasyonlar hiçbir zaman otomatik silinmez.
    idempotency_ttl_hours: int = 168
    database_url: str = ""
    ffmpeg_path: str = ""

    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def is_mock(self) -> bool:
        value = self.mock_ai.strip().lower()
        if value in {"1", "true", "yes"}:
            return True
        if value in {"0", "false", "no"}:
            return False
        return not self.gemini_api_key

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite:///{(self.storage_dir / 'clipcut.db').as_posix()}"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    (settings.storage_dir / "projects").mkdir(exist_ok=True)
    return settings
