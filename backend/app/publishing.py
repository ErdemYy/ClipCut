"""Validated publishing requests and local, deterministic speech-activity clip ranking."""
from __future__ import annotations

import math
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


class ClipExportBody(RenderOptions):
    analysis_id: str = Field(..., pattern=r"^[a-f0-9]{12}$")
    clip_ids: list[int] = Field(..., min_length=1, max_length=10)
    aspect_ratio: Format = "9:16"
    fill: Literal["blur", "fit", "crop"] = "blur"

    @field_validator("clip_ids")
    @classmethod
    def unique_clip_ids(cls, values):
        return list(dict.fromkeys(values))


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


def rank_clips(duration: float, silences: list[tuple[float, float]], options: ClipAnalyzeBody,
               transcript: dict | None = None) -> list[dict]:
    """Rank disjoint 30–60s source windows. Scores are activity, NOT virality."""
    if not math.isfinite(duration) or duration < options.min_duration:
        return []
    speech = [(0.0, duration)]
    pauses = []
    for start, end in sorted(silences):
        if not (math.isfinite(start) and math.isfinite(end)):
            continue
        start, end = max(0.0, start), min(duration, end)
        if end > start:
            speech = subtract(speech, (start, end))
            pauses.append((start, end))
    # Ignore fabricated mock transcripts and voiceover transcripts (caller chooses source).
    segments = (transcript or {}).get("segments", []) if not (transcript or {}).get("mock") else []
    starts = {0.0, max(0.0, duration - options.min_duration)}
    # Bound grid size even for multi-hour sources.
    step = max(5.0, duration / 1800)
    starts.update(i * step for i in range(int(duration / step) + 1))
    starts.update(s for s, _ in speech)
    starts.update(float(s["start"]) for s in segments if 0 <= s.get("start", -1) < duration)
    lengths = sorted({options.min_duration, (options.min_duration + options.max_duration) / 2, options.max_duration})
    candidates = []
    for start in sorted(starts):
        for length in lengths:
            end = min(duration, start + length)
            span = end - start
            if span < options.min_duration - 0.001:
                continue
            active = sum(max(0.0, min(end, b) - max(start, a)) for a, b in speech)
            ratio = active / span
            if ratio < 0.4:
                continue
            matching = [s for s in segments if s.get("end", 0) > start and s.get("start", duration) < end]
            # Prefer actual word timestamps. Weight text-only segments by overlap.
            words = 0.0
            for seg in matching:
                if seg.get("words"):
                    words += sum(start <= w.get("start", -1) < end for w in seg["words"])
                else:
                    overlap = max(0, min(end, seg["end"]) - max(start, seg["start"]))
                    words += len(seg.get("text", "").split()) * overlap / max(0.01, seg["end"] - seg["start"])
            wpm = words * 60 / span if matching else None
            cadence = max(0.0, 1 - abs((wpm or 150) - 150) / 180)
            # Pause-aligned boundaries reduce mid-sentence starts/ends.
            boundary = (any(abs(start - a) <= 0.6 for a, _ in speech) or start == 0)
            boundary += (any(abs(end - b) <= 0.6 for _, b in speech) or end == duration)
            score = 100 * (ratio * 0.75 + cadence * 0.15 + boundary * 0.05)
            candidates.append({"start": round(start, 3), "end": round(end, 3), "duration": round(span, 3),
                               "score": round(score, 1), "speech_ratio": round(ratio, 3),
                               "words_per_minute": round(wpm) if wpm is not None else None,
                               "excerpt": " ".join(s.get("text", "") for s in matching)[:240],
                               "reason": "Yoğun konuşma ve az sessizlik" + ("; duraklama sınırına yakın" if boundary else "")})
    chosen = []
    for item in sorted(candidates, key=lambda c: (-c["score"], c["start"], -c["duration"])):
        if any(item["start"] < prev["end"] and item["end"] > prev["start"] for prev in chosen):
            continue
        chosen.append(item)
        if len(chosen) >= options.max_clips:
            break
    return [{"id": i, **item} for i, item in enumerate(sorted(chosen, key=lambda c: c["start"]))]
