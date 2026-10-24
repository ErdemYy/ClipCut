"""Selectable AI models and pre-generation cost estimates.

Prices are provider list prices, not a quote or an invoice. They are
deliberately kept in one place with a read date so an operator can update
them when the provider changes pricing. No network call is made here.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Optional

from .. import config

PRICING_READ_AT = "2026-10-22"
PRICING_NOTE = (
    "Tahmini Google Gemini API liste fiyatları (22 Ekim 2026'da okundu). "
    "Vergi, kur, bölge, çözünürlük, başarısız/iptal istekler ve sağlayıcı zamları dahil değildir; "
    "kesin fatura değildir. Edge TTS ücretsizdir, ancak konuşma metni Microsoft servisine gönderilir. "
    "Fiyatı bilinmeyen modelde tahmin üretilmez."
)

TEXT_LABELS = {
    "gemini-2.5-flash": "Gemini 2.5 Flash",
    "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
}
# USD per 1M tokens: (input, output). Used only for a planning estimate.
TEXT_PRICES = {
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.5-pro": (1.25, 10.00),
}
VIDEO_LABELS = {
    "veo-3.0-fast-generate-001": "Veo 3 Fast",
    "veo-3.0-generate-001": "Veo 3 Standard",
    "veo-3.1-fast-generate-001": "Veo 3.1 Fast",
    "veo-3.1-generate-001": "Veo 3.1 Standard",
    "veo-3.1-lite-generate-001": "Veo 3.1 Lite",
    "veo-3.1-fast-generate-preview": "Veo 3.1 Fast (Preview)",
    "veo-3.1-generate-preview": "Veo 3.1 Standard (Preview)",
    "veo-3.1-lite-generate-preview": "Veo 3.1 Lite (Preview)",
    "gemini-omni-flash": "Gemini Omni Flash",
}
# Conservative USD per output second, 720p with audio where applicable.
VIDEO_PRICES = {
    "veo-3.0-fast-generate-001": 0.15,
    "veo-3.0-generate-001": 0.40,
    "veo-3.1-fast-generate-001": 0.12,
    "veo-3.1-generate-001": 0.40,
    "veo-3.1-lite-generate-001": 0.08,
    "veo-3.1-fast-generate-preview": 0.12,
    "veo-3.1-generate-preview": 0.40,
    "veo-3.1-lite-generate-preview": 0.08,
    "gemini-omni-flash": 0.10,
}
CLOSED_VIDEO_MODELS = {
    "veo-3.1-fast-generate-preview",
    "veo-3.1-generate-preview",
    "veo-3.1-lite-generate-preview",
}


class UnknownModel(ValueError):
    pass


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    kind: str  # text | video
    status: str  # active | deprecated | closed | unpriced
    configured: bool
    selectable: bool
    note: Optional[str]
    durations: list[int]
    price_per_second: Optional[float] = None
    input_per_million: Optional[float] = None
    output_per_million: Optional[float] = None

    def public(self) -> dict:
        return asdict(self)


def _split(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _text_ids() -> list[str]:
    settings = config.get_settings()
    ids = [settings.gemini_text_model, *_split(settings.text_model_options)]
    return list(dict.fromkeys(ids))


def _video_ids() -> list[str]:
    settings = config.get_settings()
    ids = [settings.veo_model, *_split(settings.veo_model_options)]
    return list(dict.fromkeys(ids))


def video_durations(model: str, mock: bool = False) -> list[int]:
    """Veo 3.0 only returns 8s clips; others accept 4/6/8 per current API."""
    return [4, 6, 8] if mock or not model.startswith("veo-3.0") else [8]


def video_model_status(model: str) -> str:
    if model in CLOSED_VIDEO_MODELS:
        return "closed"
    if model.startswith("veo-3.0"):
        return "deprecated"
    return "active" if model in VIDEO_PRICES else "unpriced"


def video_model_warning(model: str) -> Optional[str]:
    if model in CLOSED_VIDEO_MODELS:
        return (
            "Seçili Veo 3.1 Preview modeli 22 Ekim 2026'da kapatıldı. Model yalnızca yapılandırmada "
            "kalmışsa görünür; yeni çağrı başarısız olabilir. Otomatik model geçişi yapılmaz."
        )
    if model.startswith("veo-3.0"):
        return (
            "Seçili Veo 3.0 modeli Google dokümanında deprecated olarak işaretli ve yalnızca 8 sn "
            "sahne destekliyor. Gerçek erişim doğrulanmadı; API bağlarken model kullanılabilirliğini kontrol edin. "
            "Otomatik model geçişi yapılmaz."
        )
    if model not in VIDEO_PRICES:
        return "Bu video modelinin liste fiyatı katalogda yok; maliyet tahmini üretilemez."
    return None


def _text_model(model_id: str) -> ModelInfo:
    settings = config.get_settings()
    price = TEXT_PRICES.get(model_id)
    configured = model_id == settings.gemini_text_model
    return ModelInfo(
        id=model_id,
        label=TEXT_LABELS.get(model_id, model_id),
        kind="text",
        status="active" if price else "unpriced",
        configured=configured,
        selectable=True,
        note=None if price else "Bu metin modelinin liste fiyatı katalogda yok.",
        durations=[],
        input_per_million=price[0] if price else None,
        output_per_million=price[1] if price else None,
    )


def _video_model(model_id: str) -> ModelInfo:
    settings = config.get_settings()
    price = VIDEO_PRICES.get(model_id)
    return ModelInfo(
        id=model_id,
        label=VIDEO_LABELS.get(model_id, model_id),
        kind="video",
        status=video_model_status(model_id),
        configured=model_id == settings.veo_model,
        selectable=True,
        note=video_model_warning(model_id),
        durations=video_durations(model_id, settings.is_mock),
        price_per_second=price,
    )


def text_models() -> list[ModelInfo]:
    return [_text_model(model_id) for model_id in _text_ids()]


def video_models() -> list[ModelInfo]:
    return [_video_model(model_id) for model_id in _video_ids()]


def model_catalog() -> dict:
    settings = config.get_settings()
    return {
        "mock": settings.is_mock,
        "defaults": {"text_model": settings.gemini_text_model, "video_model": settings.veo_model},
        "text": [model.public() for model in text_models()],
        "video": [model.public() for model in video_models()],
        "pricing_read_at": PRICING_READ_AT,
        "pricing_note": PRICING_NOTE,
    }


def resolve_text_model(model_id: Optional[str]) -> ModelInfo:
    target = model_id or config.get_settings().gemini_text_model
    match = next((model for model in text_models() if model.id == target), None)
    if match is None:
        raise UnknownModel("Bu metin modeli seçilebilir modeller arasında değil.")
    return match


def resolve_video_model(model_id: Optional[str]) -> ModelInfo:
    target = model_id or config.get_settings().veo_model
    match = next((model for model in video_models() if model.id == target), None)
    if match is None:
        raise UnknownModel("Bu video modeli seçilebilir modeller arasında değil.")
    return match


def _planning_cost(scene_count: int, brief_chars: int, model: ModelInfo) -> Optional[float]:
    if scene_count <= 0:
        return 0.0
    if model.input_per_million is None or model.output_per_million is None:
        return None
    # Rough, round-up token estimate: a fixed instruction block, the brief at
    # ~4 chars/token, and a structured scene object per requested scene.
    input_tokens = max(1, math.ceil(max(0, brief_chars) / 4)) + 600
    output_tokens = 180 + scene_count * 180
    return round((input_tokens * model.input_per_million + output_tokens * model.output_per_million) / 1_000_000, 6)


def preflight(
    *,
    video_model: Optional[str] = None,
    text_model: Optional[str] = None,
    scene_durations: Optional[list[int]] = None,
    voiceover: bool = False,
    planning_scene_count: int = 0,
    planning_chars: int = 0,
) -> dict:
    """Return a deterministic, explicitly-estimated cost breakdown.

    Mock mode is free and marked as such. A missing list price yields
    ``estimated_usd=None`` rather than a false zero.
    """
    settings = config.get_settings()
    video = resolve_video_model(video_model)
    text = resolve_text_model(text_model)
    durations = list(scene_durations or [])
    if any(duration not in video.durations for duration in durations):
        raise ValueError(
            f"{video.label} için sahne süresi {', '.join(str(value) for value in video.durations)} sn olmalı."
        )

    video_seconds = sum(durations)
    if settings.is_mock:
        video_cost = 0.0
    elif video.price_per_second is not None:
        video_cost = round(video_seconds * video.price_per_second, 6)
    else:
        video_cost = None
    planning_cost = 0.0 if settings.is_mock else _planning_cost(planning_scene_count, planning_chars, text)
    tts_calls = len(durations) if voiceover else 0

    components = []
    if durations:
        components.append({
            "label": "Video üretimi",
            "detail": f"{len(durations)} sahne · {video_seconds} sn · {video.label}",
            "usd": video_cost,
        })
    if planning_scene_count:
        components.append({
            "label": "Sahne planlama",
            "detail": f"1 metin çağrısı · {planning_scene_count} sahne · {text.label}",
            "usd": planning_cost,
        })
    if tts_calls:
        components.append({
            "label": "Seslendirme",
            "detail": f"{tts_calls} Edge TTS çağrısı · ücretsiz",
            "usd": 0.0,
        })

    required_costs = [component["usd"] for component in components if component["usd"] is not None]
    priced = all(component["usd"] is not None for component in components)
    estimated = round(sum(required_costs), 4) if priced else None
    warnings = []
    if settings.is_mock:
        warnings.append("Demo modu: gerçek sağlayıcı çağrısı yapılmaz, ücret oluşmaz.")
    if video.note:
        warnings.append(video.note)
    if text.note and planning_scene_count:
        warnings.append(text.note)
    return {
        "mock": settings.is_mock,
        "priced": priced,
        "video_model": video.public(),
        "text_model": text.public(),
        "video_calls": len(durations),
        "video_seconds": video_seconds,
        "tts_calls": tts_calls,
        "planning_calls": 1 if planning_scene_count else 0,
        "estimated_usd": estimated,
        "components": components,
        "warnings": list(dict.fromkeys(warnings)),
        "pricing_read_at": PRICING_READ_AT,
        "pricing_note": PRICING_NOTE,
    }


def budget_error(estimate: dict, max_cost_usd: Optional[float]) -> Optional[str]:
    """Return a user-facing rejection when a confirmed budget cannot be met."""
    if max_cost_usd is None:
        return None
    if estimate["mock"]:
        return None
    amount = estimate["estimated_usd"]
    if amount is None:
        return "Seçili modelin fiyatı bilinmediği için bütçe sınırı doğrulanamaz. Fiyatı bilinen bir model seçin."
    if amount > max_cost_usd + 1e-9:
        return (
            f"Tahmini maliyet ${amount:.4f}, belirlediğiniz ${max_cost_usd:.4f} bütçesini aşıyor. "
            "Sahne sayısı/süresini veya modeli değiştirin. Hiçbir üretim çağrısı başlatılmadı."
        )
    return None
