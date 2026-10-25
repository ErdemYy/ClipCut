"""Validated publishing requests and local, deterministic speech-activity clip ranking."""
from __future__ import annotations

import bisect
import math
import re
from collections import Counter
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .edit.schema import EditPlan, ReframeOp, TrimOp
from .edit.timeline import subtract

Format = Literal["9:16", "1:1", "4:5", "16:9"]
FORMAT_NAMES = {"9:16": "reels_tiktok", "1:1": "instagram_square", "4:5": "instagram_portrait", "16:9": "youtube"}


class RenderOptions(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    resolution: Literal["720p", "1080p", "4k"] = "1080p"
    quality: Literal["fast", "standard", "high"] = "standard"


class BatchExportBody(RenderOptions):
    formats: list[Format] = Field(default_factory=lambda: list(FORMAT_NAMES), min_length=1, max_length=4)
    fill: Literal["blur", "fit", "crop"] = "blur"
    thumbnail_at: float = Field(0, ge=0)

    @field_validator("formats")
    @classmethod
    def unique_formats(cls, values):
        return list(dict.fromkeys(values))


class PreviewBody(RenderOptions):
    start: float = Field(0, ge=0)
    duration: Literal[5, 10] = 5


def preview_window(start: float, duration: float, total: float) -> float:
    """Clamp to the edited output's end, never source time or an empty tail."""
    if not all(math.isfinite(v) for v in (start, duration, total)) or start < 0 or duration <= 0 or total - start < 0.1 - 1e-9:
        raise ValueError("Başlangıç zamanı düzenlenmiş videonun bitişinden en az 0.1 sn önce olmalı.")
    return min(duration, total - start)


class ThumbnailBody(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    at: float = Field(..., ge=0)


class ClipAnalyzeBody(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    min_duration: float = Field(30, ge=30, le=60)
    max_duration: float = Field(60, ge=30, le=60)
    max_clips: int = Field(5, ge=1, le=10)
    threshold_db: float = Field(-35, ge=-60, le=-10)
    min_silence_ms: int = Field(450, ge=150, le=2000)

    @model_validator(mode="after")
    def ordered_durations(self):
        if self.max_duration < self.min_duration:
            raise ValueError("En uzun klip süresi en kısa süreden küçük olamaz.")
        return self


class ClipRange(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: int = Field(..., ge=0)
    start: float = Field(..., ge=0)
    end: float = Field(..., gt=0)

    @model_validator(mode="after")
    def ordered_range(self):
        if self.end <= self.start:
            raise ValueError("Klip bitişi başlangıçtan sonra olmalı.")
        if not (29.99 <= self.end - self.start <= 60.01):
            raise ValueError("Klip süresi 30–60 saniye arasında olmalı.")
        return self


class ClipCover(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: int = Field(..., ge=0)
    at: float = Field(..., ge=0)  # Relative to the selected clip's start.


def clip_cover_time(at: float, duration: float) -> float:
    if not all(math.isfinite(v) for v in (at, duration)) or at < 0 or duration - at < 0.1 - 1e-9:
        raise ValueError("Kapak zamanı klip içinde olmalı ve klip sonunda en az 0.1 sn kalmalı.")
    return at


class ClipExportBody(RenderOptions):
    analysis_id: str = Field(..., pattern=r"^[a-f0-9]{12}$")
    clip_ids: list[int] = Field(..., min_length=1, max_length=10)
    # Optional manual trims. When present every selected clip must have exactly one range.
    clip_ranges: list[ClipRange] | None = Field(default=None, min_length=1, max_length=10)
    clip_covers: list[ClipCover] | None = Field(default=None, min_length=1, max_length=10)
    aspect_ratio: Format = "9:16"
    fill: Literal["blur", "fit", "crop"] = "blur"

    @field_validator("clip_ids")
    @classmethod
    def unique_clip_ids(cls, values):
        return list(dict.fromkeys(values))

    @field_validator("clip_ranges")
    @classmethod
    def unique_clip_ranges(cls, values):
        if not values:
            return values
        ids = [item.id for item in values]
        if len(ids) != len(set(ids)):
            raise ValueError("Her klip için tek bir aralık gönderin.")
        return values

    @field_validator("clip_covers")
    @classmethod
    def unique_clip_covers(cls, values):
        if values and len({item.id for item in values}) != len(values):
            raise ValueError("Her klip için tek bir kapak zamanı gönderin.")
        return values


class ClipPreviewBody(RenderOptions):
    """Short, exact FFmpeg preview of one selected clip range."""
    analysis_id: str = Field(..., pattern=r"^[a-f0-9]{12}$")
    clip_id: int = Field(..., ge=0)
    clip_range: ClipRange | None = None
    aspect_ratio: Format = "9:16"
    fill: Literal["blur", "fit", "crop"] = "blur"
    # Seconds from the selected clip's beginning, NOT absolute source time.
    start: float = Field(0, ge=0)
    duration: Literal[5, 10] = 5

    @model_validator(mode="after")
    def matching_range(self):
        if self.clip_range is not None and self.clip_range.id != self.clip_id:
            raise ValueError("Önizleme aralığı seçilen kliple eşleşmiyor.")
        return self


def export_plan(plan: EditPlan, aspect: Format, fill: str) -> EditPlan:
    """Replace only the reframe; never mutate the editor's plan."""
    return EditPlan(operations=[
        *[op.model_copy(deep=True) for op in plan.operations if op.type != "reframe"],
        ReframeOp(aspect_ratio=aspect, mode=fill),
    ])


def clip_plan(plan: EditPlan, start: float, end: float, aspect: Format, fill: str) -> EditPlan:
    # Clips use source time, not the edited timeline. Timed B-roll/text/music
    # cannot be inherited without remapping; only untimed styling is retained.
    return EditPlan(operations=[
        *[op.model_copy(deep=True) for op in plan.operations if op.type in {"subtitles", "color_grade"}],
        TrimOp(start=start, end=end), ReframeOp(aspect_ratio=aspect, mode=fill),
    ])


_SENTENCE_END = re.compile(r"[.!?…][\"')\]]*$")
_TOKEN_RE = re.compile(r"[0-9A-Za-zÇĞİÖŞÜçğıöşü]+")
_QUESTION_START = re.compile(
    r"^(nasıl|neden|niye|ne zaman|nerede|nereden|nereye|kim|hangi|kaç|why|how|what|who|when|where)\b"
)
_HOOK_START = re.compile(
    r"^(en|asla|sakın|şok|gizli|sır|hata|yanlış|inanılmaz|kimse|herkes|bugün|şimdi|bakın|dikkat|"
    r"önemli|ilk|yeni|şunu|bunu|şunun|bunun)\b"
)
_FILLER_START = re.compile(r"^(yani|işte|şey|eee+|hmm+|evet|tamam|peki)\b")
# Heuristic only: curiosity/contrast language, not a claim of virality or semantic understanding.
_HOOK_TERMS = {
    "sır", "gizli", "şok", "inanılmaz", "hata", "yanlış", "asla", "sakın", "kimse", "herkes",
    "formül", "takti", "strateji", "kanıt", "bilim", "para", "kazan", "öğren", "değiştir",
    "artır", "azalt", "kaçın", "gerçek", "önemli", "dikkat", "çünkü", "aslında", "fakat",
    "ama", "ancak", "sadece", "bile", "bunu", "şunu", "bunun", "şunun",
}
_STOPWORDS = {
    "ama", "ancak", "aslında", "az", "bazı", "belki", "ben", "bana", "beni", "benim", "bir",
    "bize", "biz", "bu", "buna", "bunu", "bunun", "çok", "çünkü", "da", "daha", "de", "değil",
    "diye", "eğer", "en", "gibi", "hem", "her", "hiç", "için", "ile", "ise", "kadar", "ki",
    "kim", "mi", "mu", "mü", "nasıl", "ne", "neden", "nerede", "o", "olarak", "oldu", "olduğu",
    "olmak", "on", "ona", "onu", "onun", "öyle", "sadece", "şey", "şu", "ve", "veya", "ya",
    "yani", "yerine", "zaten", "the", "and", "for", "that", "this", "with", "you", "your",
    "are", "was", "were", "have", "has", "had", "but", "not", "from", "they", "them", "what",
    "when", "where", "who", "how", "why", "will", "can", "our", "their", "about", "into",
    "just", "also", "very", "more", "than", "then", "there", "here", "its",
}


def _clean_transcript(transcript: dict | None, duration: float) -> tuple[list[dict], list[dict]]:
    """Return source transcript segments/sentences; reject mock or voiceover provenance."""
    if not transcript or transcript.get("mock"):
        return [], []
    if transcript.get("timing_basis") == "voiceover":
        return [], []
    if "words" in transcript and transcript.get("timing_basis") != "source":
        return [], []
    segments = []
    for raw in transcript.get("segments") or []:
        try:
            start = max(0.0, float(raw.get("start", -1)))
            end = min(duration, float(raw.get("end", -1)))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end)) or end <= start:
            continue
        words = []
        for raw_word in raw.get("words") or []:
            try:
                word_start = float(raw_word.get("start", -1))
                word_end = float(raw_word.get("end", -1))
            except (TypeError, ValueError):
                continue
            text = str(raw_word.get("text") or "").strip()
            if text and math.isfinite(word_start) and math.isfinite(word_end) and word_end > word_start:
                words.append({"start": word_start, "end": word_end, "text": text})
        words.sort(key=lambda word: (word["start"], word["end"]))
        text = str(raw.get("text") or "").strip()
        if text or words:
            segments.append({"start": start, "end": end, "text": text, "words": words})
    segments.sort(key=lambda segment: (segment["start"], segment["end"]))
    return segments, _sentences(segments)


def _sentence(words: list[dict]) -> dict:
    return {"start": words[0]["start"], "end": words[-1]["end"],
            "text": " ".join(word["text"] for word in words).strip()}


def _sentences(segments: list[dict]) -> list[dict]:
    sentences = []
    for segment in segments:
        if not segment["words"]:
            sentences.append({"start": segment["start"], "end": segment["end"], "text": segment["text"]})
            continue
        current = []
        for word in segment["words"]:
            current.append(word)
            if _SENTENCE_END.search(word["text"]):
                sentences.append(_sentence(current))
                current = []
        if current:
            sentences.append(_sentence(current))
    return sorted((sentence for sentence in sentences if sentence["text"]),
                  key=lambda sentence: (sentence["start"], sentence["end"]))


def _near(value: float, values: list[float], tolerance: float = 0.5) -> bool:
    index = bisect.bisect_left(values, value)
    distance = min((abs(values[j] - value) for j in (index - 1, index) if 0 <= j < len(values)),
                   default=math.inf)
    return distance <= tolerance


def sentence_boundaries(duration: float, transcript: dict | None) -> dict[str, list[float]]:
    """Expose the same source sentence edges used by clip ranking for UI snapping."""
    if not math.isfinite(duration) or duration <= 0:
        return {"starts": [], "ends": []}
    _, sentences = _clean_transcript(transcript, duration)
    return {
        "starts": sorted({round(sentence["start"], 3) for sentence in sentences
                          if 0 <= sentence["start"] < duration}),
        "ends": sorted({round(sentence["end"], 3) for sentence in sentences
                        if 0 < sentence["end"] <= duration}),
    }


def _matching_segments(segments: list[dict], starts: list[float], start: float, end: float) -> list[dict]:
    index = bisect.bisect_left(starts, start)
    if index and segments[index - 1]["end"] > start:
        index -= 1
    matched = []
    while index < len(segments) and segments[index]["start"] < end:
        if segments[index]["end"] > start:
            matched.append(segments[index])
        index += 1
    return matched


def _window_words(words: list[dict], starts: list[float], start: float, end: float) -> list[dict]:
    index = bisect.bisect_left(starts, start)
    if index and words[index - 1]["end"] > start:
        index -= 1
    matched = []
    while index < len(words) and words[index]["start"] < end:
        if words[index]["end"] > start:
            matched.append(words[index])
        index += 1
    return matched


def _content_tokens(text: str) -> list[str]:
    return [token for token in _TOKEN_RE.findall(text.casefold())
            if len(token) >= 3 and not token.isdigit() and token not in _STOPWORDS]


def _hook_score(text: str, aligned: bool) -> float:
    cleaned = text.strip().casefold()
    if not cleaned:
        return 0.25 if aligned else 0.1
    score = 0.3 if aligned else 0.18
    if "?" in cleaned or _QUESTION_START.search(cleaned):
        score = max(score, 0.95)
    elif _HOOK_START.search(cleaned):
        score = max(score, 0.82)
    if "!" in cleaned:
        score = max(score, 0.72)
    if re.search(r"\d", cleaned):
        score = max(score, 0.72)
    if set(_TOKEN_RE.findall(cleaned)) & _HOOK_TERMS:
        score = max(score, 0.68)
    if _FILLER_START.search(cleaned):
        score = min(score, 0.22)
    return round(min(1.0, max(0.0, score)), 3)


def _candidate_ends(start: float, duration: float, options: ClipAnalyzeBody,
                    sentence_ends: list[float]) -> list[float]:
    low = start + options.min_duration
    high = min(duration, start + options.max_duration)
    if high < low - 0.001:
        return []
    targets = [min(duration, start + options.min_duration),
               min(duration, start + (options.min_duration + options.max_duration) / 2),
               min(duration, start + options.max_duration)]
    ends = {round(target, 3) for target in targets if target - start >= options.min_duration - 0.001}
    for target in targets:
        index = bisect.bisect_left(sentence_ends, target)
        for offset in (index - 1, index):
            if 0 <= offset < len(sentence_ends):
                end = sentence_ends[offset]
                if low - 0.001 <= end <= high + 0.001:
                    ends.add(round(end, 3))
    return sorted(ends)


def rank_clips(duration: float, silences: list[tuple[float, float]], options: ClipAnalyzeBody,
               transcript: dict | None = None) -> list[dict]:
    """Rank disjoint 30–60s source windows with local audio and transcript heuristics.

    Scores combine speech activity with sentence boundaries, an opening-hook
    heuristic and repeated topic terms when a real source transcript exists.
    They are NOT virality, semantic importance or paid-AI judgments.
    """
    if not math.isfinite(duration) or duration < options.min_duration:
        return []
    speech = [(0.0, duration)]
    for start, end in sorted(silences):
        if not (math.isfinite(start) and math.isfinite(end)):
            continue
        start, end = max(0.0, start), min(duration, end)
        if end > start:
            speech = subtract(speech, (start, end))
    segments, sentences = _clean_transcript(transcript, duration)
    words = sorted((word for segment in segments for word in segment["words"]),
                   key=lambda word: (word["start"], word["end"]))
    segment_starts = [segment["start"] for segment in segments]
    word_starts = [word["start"] for word in words]
    sentence_starts = [sentence["start"] for sentence in sentences]
    sentence_ends = [sentence["end"] for sentence in sentences]
    transcript_used = bool(sentences)
    top_terms: set[str] = set()
    if transcript_used:
        counts = Counter(_content_tokens(" ".join(segment["text"] for segment in segments)))
        top_terms = {term for term, _ in counts.most_common(12)}

    starts = {0.0, max(0.0, duration - options.min_duration)}
    # Bound grid size even for multi-hour sources.
    step = max(5.0, duration / 1800)
    starts.update(i * step for i in range(int(duration / step) + 1))
    starts.update(start for start, _ in speech)
    starts.update(segment_starts)
    starts.update(sentence_starts)

    candidates = []
    for start in sorted(starts):
        for end in _candidate_ends(start, duration, options, sentence_ends):
            span = end - start
            if span < options.min_duration - 0.001:
                continue
            active = sum(max(0.0, min(end, b) - max(start, a)) for a, b in speech)
            ratio = active / span
            if ratio < 0.4:
                continue
            matching = _matching_segments(segments, segment_starts, start, end)
            # Prefer actual word timestamps. Weight text-only segments by overlap.
            word_count = 0.0
            for segment in matching:
                if segment["words"]:
                    word_count += sum(1 for word in segment["words"] if start <= word["start"] < end)
                else:
                    overlap = max(0.0, min(end, segment["end"]) - max(start, segment["start"]))
                    word_count += len(segment["text"].split()) * overlap / max(0.01, segment["end"] - segment["start"])
            wpm = word_count * 60 / span if matching else None
            cadence = max(0.0, 1 - abs((wpm or 150) - 150) / 180)
            start_boundary = start <= 0.001 or any(abs(start - a) <= 0.6 for a, _ in speech)
            end_boundary = end >= duration - 0.001 or any(abs(end - b) <= 0.6 for _, b in speech)
            boundary = (float(start_boundary) + float(end_boundary)) / 2
            excerpt = " ".join(segment["text"] for segment in matching)[:240]

            completeness = hook = topic = None
            start_aligned = end_aligned = False
            if transcript_used:
                start_aligned = _near(start, sentence_starts)
                end_aligned = _near(end, sentence_ends)
                completeness = (float(start_aligned) + float(end_aligned)) / 2
                window_words = _window_words(words, word_starts, start, end)
                hook_words = [word for word in window_words if word["start"] < start + 6]
                hook_text = " ".join(word["text"] for word in hook_words)
                if not hook_text and matching:
                    hook_text = matching[0]["text"][:220]
                hook = _hook_score(hook_text, start_aligned)
                topic_text = " ".join(word["text"] for word in window_words) if window_words else excerpt
                tokens = _content_tokens(topic_text)
                if tokens:
                    density = sum(token in top_terms for token in tokens) / len(tokens)
                    diversity = len(set(tokens)) / len(tokens)
                    topic = min(1.0, density * 4) * 0.7 + diversity * 0.3
                else:
                    topic = 0.0

            if transcript_used:
                score = 100 * (ratio * 0.35 + cadence * 0.10 + boundary * 0.10
                               + completeness * 0.20 + hook * 0.15 + topic * 0.10)
            else:
                score = 100 * (ratio * 0.60 + cadence * 0.20 + boundary * 0.20)
            reasons = []
            if ratio >= 0.9:
                reasons.append("konuşma yoğun")
            elif ratio >= 0.7:
                reasons.append("az sessizlik")
            if completeness is not None and completeness >= 0.999:
                reasons.append("tam cümle sınırları")
            elif start_aligned:
                reasons.append("cümle başlangıcı")
            elif end_aligned:
                reasons.append("cümle bitişi")
            if hook is not None and hook >= 0.85:
                reasons.append("soru/merak kancası")
            elif hook is not None and hook >= 0.7:
                reasons.append("güçlü açılış")
            if topic is not None and topic >= 0.65:
                reasons.append("konu terimleri yoğun")
            if boundary >= 0.999:
                reasons.append("duraklama sınırları")
            signals = {"speech": round(ratio, 3), "cadence": round(cadence, 3),
                       "boundary": round(boundary, 3)}
            if transcript_used:
                signals.update({"completeness": round(completeness, 3), "hook": round(hook, 3),
                                "topic": round(topic, 3)})
            candidates.append({
                "start": round(start, 3), "end": round(end, 3), "duration": round(span, 3),
                "score": round(min(100.0, max(0.0, score)), 1),
                "speech_ratio": round(ratio, 3),
                "words_per_minute": round(wpm) if wpm is not None else None,
                "excerpt": excerpt,
                "reason": "; ".join(reasons) or "Yerel konuşma aktivitesi",
                "transcript_used": transcript_used,
                "sentence_aligned": bool(transcript_used and completeness >= 0.999),
                "hook_score": round(hook, 3) if hook is not None else None,
                "topic_score": round(topic, 3) if topic is not None else None,
                "signals": signals,
            })
    chosen = []
    for item in sorted(candidates, key=lambda candidate: (-candidate["score"], candidate["start"],
                                                          -candidate["duration"])):
        if any(item["start"] < previous["end"] and item["end"] > previous["start"] for previous in chosen):
            continue
        chosen.append(item)
        if len(chosen) >= options.max_clips:
            break
    return [{"id": i, **item} for i, item in enumerate(sorted(chosen, key=lambda candidate: candidate["start"]))]
