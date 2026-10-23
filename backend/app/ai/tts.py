"""ClipCut AI Seslendirme (Text-to-Speech) Modülü.

Doğal sinirsel sesler (neural TTS) ile metinden stüdyo kalitesinde ses üretir
ve mikrosaniye hassasiyetinde kelime zaman damgaları çıkarır.
"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any, Optional

from ..ffmpeg import probe, run_ffmpeg
from ..subtitles.builder import distribute_words

log = logging.getLogger("clipcut.tts")

VOICES = [
    {
        "id": "tr-TR-EmelNeural",
        "name": "Emel",
        "gender": "female",
        "language": "tr",
        "accent": "Türkçe",
        "style": "Sıcak & Samimi",
        "description": "Kadın · Sıcak, akıcı ve modern anlatım (Önerilen)",
    },
    {
        "id": "tr-TR-AhmetNeural",
        "name": "Ahmet",
        "gender": "male",
        "language": "tr",
        "accent": "Türkçe",
        "style": "Doğal & Akıcı",
        "description": "Erkek · Net ve tok anlatıcı tonu",
    },
    {
        "id": "en-US-JennyNeural",
        "name": "Jenny",
        "gender": "female",
        "language": "en",
        "accent": "US English",
        "style": "Energetic & Modern",
        "description": "Female · Friendly, upbeat, perfect for TikTok & Shorts",
    },
    {
        "id": "en-US-GuyNeural",
        "name": "Guy",
        "gender": "male",
        "language": "en",
        "accent": "US English",
        "style": "Deep & Narrative",
        "description": "Male · Deep, authoritative promo voice",
    },
    {
        "id": "en-US-ChristopherNeural",
        "name": "Christopher",
        "gender": "male",
        "language": "en",
        "accent": "US English",
        "style": "Storyteller",
        "description": "Male · Warm, conversational and engaging",
    },
    {
        "id": "de-DE-KillianNeural",
        "name": "Killian",
        "gender": "male",
        "language": "de",
        "accent": "Deutsch",
        "style": "Professionell",
        "description": "Männlich · Klar und sachlich",
    },
    {
        "id": "es-ES-AlvaroNeural",
        "name": "Alvaro",
        "gender": "male",
        "language": "es",
        "accent": "Español",
        "style": "Dinámico",
        "description": "Masculino · Expresivo y natural",
    },
]


def list_voices() -> list[dict[str, Any]]:
    return VOICES


def get_voice(voice_id: str) -> dict[str, Any] | None:
    return next((v for v in VOICES if v["id"] == voice_id), None)


async def _edge_tts_generate(
    text: str, voice: str, speed_factor: float, out_path: Path
) -> tuple[float, list[dict[str, Any]]]:
    import edge_tts

    rate_pct = int(round((speed_factor - 1.0) * 100))
    rate_str = f"{rate_pct:+d}%"

    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate_str)
    words: list[dict[str, Any]] = []

    async def _stream_to_file():
        with out_path.open("wb") as f:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    w_start = round(chunk["offset"] / 10_000_000, 3)
                    w_dur = round(chunk["duration"] / 10_000_000, 3)
                    w_text = chunk["text"].strip()
                    if w_text:
                        words.append({"text": w_text, "start": w_start, "end": round(w_start + w_dur, 3)})

    # En fazla 12 saniye bekle, takılma durumunda timeout fırlatıp fallback'e geçsin
    await asyncio.wait_for(_stream_to_file(), timeout=12.0)

    info = probe(out_path)
    if not words:
        words_objs = distribute_words(text, 0.08, max(0.2, info.duration - 0.08))
        words = [{"text": w.text, "start": round(w.start, 3), "end": round(w.end, 3)} for w in words_objs]

    return info.duration, words


def _fallback_generate(
    text: str, speed_factor: float, out_path: Path
) -> tuple[float, list[dict[str, Any]]]:
    """Çevrimdışı / yedek ses üretici (FFmpeg ton modülasyonu ile konuşma ritmi simülasyonu)."""
    words_list = text.split()
    total_words = max(1, len(words_list))
    # Ortalama konuşma hızı: dakikada ~140 kelime => kelime başı ~0.43 sn
    est_duration = max(1.5, (total_words * 0.43) / max(0.5, speed_factor))

    # Konuşma ritminde hafif armonik ton
    run_ffmpeg([
        "-f", "lavfi",
        "-i", f"aevalsrc='0.15*sin(2*PI*180*t*(1+0.08*sin(2*PI*3*t)))*(0.7+0.3*sin(2*PI*5*t))':s=44100:d={est_duration:.2f}",
        "-af", "lowpass=f=2800,afade=t=in:d=0.1,afade=t=out:st=" + f"{est_duration - 0.2:.2f}:d=0.2",
        "-b:a", "128k",
        str(out_path),
    ])

    words_objs = distribute_words(text, 0.1, est_duration - 0.1)
    words = [w.__dict__ for w in words_objs]
    return est_duration, words


def _build_segments(words: list[dict[str, Any]], full_text: str, total_duration: float) -> list[dict[str, Any]]:
    """Kelimeleri noktalama işaretlerine göre doğal cümle segmentlerine gruplar."""
    if not words:
        return []

    sentence_ends = (".", "!", "?", "…", ":", ";")
    segments: list[dict[str, Any]] = []
    curr_words: list[dict[str, Any]] = []
    seg_id = 0

    for w in words:
        curr_words.append(w)
        text_strip = w["text"].rstrip()
        is_end = any(text_strip.endswith(p) for p in sentence_ends)
        # 10 kelimeyi aştıysa veya cümle bittiyse segmenti kapat
        if is_end or len(curr_words) >= 9:
            s_start = curr_words[0]["start"]
            s_end = curr_words[-1]["end"]
            seg_text = " ".join(cw["text"] for cw in curr_words)
            segments.append({
                "id": seg_id,
                "start": s_start,
                "end": s_end,
                "text": seg_text,
                "words": list(curr_words),
            })
            seg_id += 1
            curr_words = []

    if curr_words:
        segments.append({
            "id": seg_id,
            "start": curr_words[0]["start"],
            "end": curr_words[-1]["end"],
            "text": " ".join(cw["text"] for cw in curr_words),
            "words": list(curr_words),
        })

    return segments


def generate_voiceover(
    text: str,
    voice_id: str = "tr-TR-AhmetNeural",
    speed: float = 1.0,
    out_path: Path | None = None,
    *, mock_mode: bool | None = None, allow_fallback: bool = True,
) -> dict[str, Any]:
    """Ses dosyasını üretir ve kelime zaman damgalı transkript sözlüğü döner."""
    clean_text = text.strip()
    if not clean_text:
        raise ValueError("Seslendirilecek metin boş olamaz.")

    out_file = out_path or (Path("storage") / "temp_voiceover.mp3")
    out_file.parent.mkdir(parents=True, exist_ok=True)

    words: list[dict[str, Any]] = []
    duration = 0.0

    from ..config import get_settings

    synthetic = get_settings().is_mock if mock_mode is None else mock_mode
    if synthetic:
        duration, words = _fallback_generate(clean_text, speed, out_file)
    else:
        try:
            duration, words = asyncio.run(_edge_tts_generate(clean_text, voice_id, speed, out_file))
        except Exception as exc:
            if not allow_fallback:
                raise RuntimeError("Seslendirme başarısız; gerçek konuşma yerine demo tonu kullanılmadı.") from exc
            log.warning("edge-tts başarısız; demo tonu kullanılıyor: %s", exc)
            synthetic = True
            duration, words = _fallback_generate(clean_text, speed, out_file)

    segments = _build_segments(words, clean_text, duration)
    voice_info = get_voice(voice_id)
    lang = voice_info["language"] if voice_info else "tr"

    return {
        "file": str(out_file),
        "duration": round(duration, 3),
        "language": lang,
        "voice": voice_id,
        "segments": segments,
        "words": words,
        "mock": synthetic,
    }
