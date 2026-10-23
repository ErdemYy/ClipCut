"""Gemini tabanlı AI servisleri: transkripsiyon, çeviri, edit planlama, Veo video üretimi.

MOCK modunda (API anahtarı yoksa) her servis gerçekçi, deterministik sahte sonuçlar döner.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel, ValidationError

from ..config import get_settings
from ..edit.schema import EditPlan, dsl_reference
from ..subtitles.builder import distribute_words
from . import mock

LANGUAGES = {
    "tr": "Türkçe", "en": "English", "de": "Deutsch", "fr": "Français", "es": "Español", "it": "Italiano",
    "pt": "Português", "ru": "Русский", "ar": "العربية", "ja": "日本語", "ko": "한국어", "zh": "中文",
    "hi": "हिन्दी", "nl": "Nederlands", "pl": "Polski", "az": "Azərbaycan", "uk": "Українська",
}


class AIError(RuntimeError):
    pass


def _client():
    from google import genai

    settings = get_settings()
    if not settings.gemini_api_key:
        raise AIError("GEMINI_API_KEY ayarlanmamış.")
    return genai.Client(api_key=settings.gemini_api_key)


def _wait_file_active(client, file, timeout: float = 300):
    start = time.time()
    while getattr(file.state, "name", str(file.state)) == "PROCESSING":
        if time.time() - start > timeout:
            raise AIError("Dosya işleme zaman aşımına uğradı.")
        time.sleep(2)
        file = client.files.get(name=file.name)
    if getattr(file.state, "name", "") == "FAILED":
        raise AIError("Gemini dosyayı işleyemedi.")
    return file


# ------------------------------------------------------------ Transkripsiyon ----

class _W(BaseModel):
    text: str
    start: float
    end: float


class _Seg(BaseModel):
    start: float
    end: float
    text: str
    words: list[_W]


class _Transcript(BaseModel):
    language: str
    segments: list[_Seg]


def transcribe(audio_path: Path, duration: float) -> dict:
    """Ses dosyasını kelime bazlı zaman damgalarıyla yazıya döker."""
    if get_settings().is_mock:
        return mock.transcript(duration)
    from google.genai import types

    client = _client()
    uploaded = _wait_file_active(client, client.files.upload(file=str(audio_path)))
    prompt = (
        "Bu ses kaydını kelimesi kelimesine, orijinal dilinde yazıya dök. "
        f"Kayıt süresi {duration:.2f} saniye. Konuşmayı 2-12 saniyelik doğal cümle segmentlerine böl. "
        "Her segment ve her kelime için saniye cinsinden (ondalıklı) başlangıç/bitiş zamanı ver; zamanlar artan sırada ve "
        "kayıt süresini aşmayacak şekilde olmalı. Noktalama işaretlerini koru. Konuşma yoksa segments boş liste olsun. "
        "language alanına ISO 639-1 dil kodunu yaz."
    )
    resp = client.models.generate_content(
        model=get_settings().gemini_transcribe_model,
        contents=[uploaded, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=_Transcript, temperature=0.0,
        ),
    )
    try:
        data = _Transcript.model_validate_json(resp.text)
    except ValidationError as exc:
        raise AIError(f"Transkripsiyon çıktısı geçersiz: {exc}") from exc
    return _clean_transcript(data.model_dump(), duration)


def _clean_transcript(data: dict, duration: float) -> dict:
    segments = []
    for i, seg in enumerate(data.get("segments", [])):
        s = max(0.0, min(duration, float(seg["start"])))
        e = max(s + 0.1, min(duration, float(seg["end"])))
        words = [w for w in seg.get("words", []) if w.get("text", "").strip()]
        valid = words and all(s - 0.5 <= w["start"] <= w["end"] <= e + 0.5 for w in words)
        if not valid:
            words = [w.__dict__ for w in distribute_words(seg["text"], s, e)]
        segments.append({"id": i, "start": s, "end": e, "text": seg["text"].strip(), "words": words})
    return {"language": data.get("language", "und"), "segments": segments}


# ------------------------------------------------------------ Çeviri ----

class _TSeg(BaseModel):
    id: int
    text: str


class _Translation(BaseModel):
    segments: list[_TSeg]


def translate(transcript: dict, target: str) -> dict:
    """Segmentleri hedef dile çevirir; kelime zamanları segment içinde yeniden dağıtılır."""
    segs = transcript.get("segments", [])
    if not segs:
        return {"language": target, "segments": []}
    if get_settings().is_mock:
        texts = {s["id"]: mock.translate_text(s["text"], target) for s in segs}
    else:
        from google.genai import types

        lang = LANGUAGES.get(target, target)
        payload = json.dumps([{"id": s["id"], "text": s["text"]} for s in segs], ensure_ascii=False)
        prompt = (
            f"Aşağıdaki video altyazı segmentlerini profesyonel bir altyazı çevirmeni gibi {lang} ({target}) diline çevir. "
            "Anlamı ve tonu koru, doğal ve akıcı ol, altyazı için kısa tut. Her segmentin id değerini aynen koru, "
            "segment birleştirme veya bölme yapma.\n\n" + payload
        )
        resp = _client().models.generate_content(
            model=get_settings().gemini_text_model,
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=_Translation, temperature=0.3),
        )
        parsed = _Translation.model_validate_json(resp.text)
        texts = {t.id: t.text for t in parsed.segments}
    out = []
    for s in segs:
        text = texts.get(s["id"], s["text"]).strip()
        out.append({
            "id": s["id"], "start": s["start"], "end": s["end"], "text": text,
            "words": [w.__dict__ for w in distribute_words(text, s["start"], s["end"])],
        })
    return {"language": target, "segments": out}


# ------------------------------------------------------------ Edit planlayıcı ----

def plan_edit(prompt: str, current: EditPlan, context: dict) -> tuple[EditPlan, str]:
    """Doğal dil komutunu mevcut plana uygulanmış yeni bir EditPlan'a çevirir."""
    if get_settings().is_mock:
        return mock.plan_edit(prompt, current, context)
    from google.genai import types

    system = (
        "Sen ClipCut'ın profesyonel video editörü yapay zekasısın. Kullanıcının komutunu, aşağıdaki DSL'e uyan "
        "TAM bir edit planına dönüştürürsün. Mevcut planı temel al: kullanıcı açıkça kaldırmak istemedikçe mevcut "
        "operasyonları koru, yalnızca istenen değişiklikleri yap. Zamanları transkripte göre belirle "
        "(trim/cut_range kaynak saniyesi, text/sfx çıktı saniyesi). Müzik ve sfx için yalnızca kütüphanedeki id'leri kullan. "
        "Yanıtı yalnızca şu JSON biçiminde ver: {\"summary\": \"kullanıcının dilinde kısa açıklama\", \"plan\": {\"operations\": [...]}}\n\n"
        "DSL:\n" + dsl_reference()
    )
    user = json.dumps({"komut": prompt, "mevcut_plan": current.model_dump(), "video": context}, ensure_ascii=False)
    client = _client()
    last_error = ""
    for _ in range(2):
        contents = user if not last_error else user + f"\n\nÖnceki yanıt geçersizdi, düzelt: {last_error}"
        resp = client.models.generate_content(
            model=get_settings().gemini_text_model,
            contents=contents,
            config=types.GenerateContentConfig(system_instruction=system, response_mime_type="application/json", temperature=0.2),
        )
        try:
            data = json.loads(resp.text)
            plan = EditPlan.model_validate(data.get("plan", data))
            return plan, str(data.get("summary", "Plan güncellendi."))
        except (ValueError, ValidationError) as exc:
            last_error = str(exc)[:1500]
    raise AIError(f"Model geçerli bir plan üretemedi: {last_error}")


# ------------------------------------------------------------ Veo video üretimi ----

def video_model_constraints() -> dict:
    settings = get_settings()
    legacy = settings.veo_model.startswith("veo-3.0")
    return {
        "video_durations": [4, 6, 8] if settings.is_mock or not legacy else [8],
        "video_model_warning": (
            "Yapılandırılan Veo 3.0 modeli Google dokümanında deprecated olarak işaretli. "
            "Gerçek erişim doğrulanmadı; API bağlarken model kullanılabilirliğini kontrol edin. Otomatik model geçişi yapılmaz."
            if legacy else
            "Veo 3.1 Preview modelleri 22 Ekim 2026 tarihinde kapatıldı; yapılandırılan modeli güncellemeniz gerekir."
            if settings.veo_model in {"veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview"} else None
        ),
    }


def generate_video(
    prompt: str, aspect_ratio: str, duration: int, negative_prompt: Optional[str], out_path: Path,
    on_progress: Callable[[float, str], None],
) -> None:
    if get_settings().is_mock:
        mock.generate_video(prompt, aspect_ratio, duration, out_path, on_progress)
        return
    if duration not in video_model_constraints()["video_durations"]:
        raise AIError("Yapılandırılan Veo 3.0 modeli için 8 saniyelik sahne seçin. Video çağrısı yapılmadı.")
    from google.genai import types

    client = _client()
    on_progress(0.05, "Veo'ya istek gönderiliyor")
    config = types.GenerateVideosConfig(
        aspect_ratio=aspect_ratio if aspect_ratio in ("16:9", "9:16") else "16:9",
        number_of_videos=1,
        negative_prompt=negative_prompt or None,
        duration_seconds=duration,
    )
    operation = client.models.generate_videos(model=get_settings().veo_model, prompt=prompt, config=config)
    started = time.time()
    while not operation.done:
        elapsed = time.time() - started
        on_progress(min(0.9, 0.08 + elapsed / 240), "Video üretiliyor (Veo)")
        if elapsed > 900:
            raise AIError("Veo üretimi zaman aşımına uğradı.")
        time.sleep(8)
        operation = client.operations.get(operation)
    if getattr(operation, "error", None):
        raise AIError(f"Veo hatası: {operation.error}")
    videos = getattr(operation.response, "generated_videos", None) or []
    if not videos:
        raise AIError("Veo video döndürmedi (içerik politikası filtresi olabilir).")
    on_progress(0.93, "Video indiriliyor")
    client.files.download(file=videos[0].video)
    videos[0].video.save(str(out_path))
