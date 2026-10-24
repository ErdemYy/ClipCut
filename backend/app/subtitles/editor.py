"""Validated, source-clock subtitle timing edits, independent of the source transcript."""
from __future__ import annotations

import hashlib
import json
import math

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .builder import distribute_words


class SubtitleWord(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="ignore")
    text: str = Field(min_length=1, max_length=1000)
    start: float = Field(ge=0)
    end: float = Field(gt=0)


class SubtitleSegment(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: int = Field(ge=0, strict=True)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=10000)
    words: list[SubtitleWord] | None = Field(default=None, min_length=1, max_length=1000)

    @field_validator("text")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Altyazı metni boş olamaz.")
        return value.strip()


class SubtitlesBody(BaseModel):
    segments: list[SubtitleSegment] = Field(max_length=5000)
    # Optional for legacy text-only API clients; the timing editor always sends it.
    revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


def subtitle_revision(snapshot: dict) -> str:
    state = {key: snapshot.get(key) for key in ("source_file", "voiceover_file", "subtitles", "subtitle_language")}
    state["duration"] = float(snapshot.get("duration", 0))
    return hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def subtitle_time_limit(snapshot: dict) -> float:
    limit = float(snapshot.get("duration", 0))
    if snapshot.get("voiceover_file"):
        # Existing standalone narration may extend past the source video. Permit
        # editing its already-known extent, but don't invent an unbounded tail.
        for transcript in (snapshot.get("subtitles"), snapshot.get("transcript")):
            for segment in (transcript or {}).get("segments", []):
                try:
                    end = float(segment["end"])
                except (KeyError, TypeError, ValueError):
                    continue
                if math.isfinite(end):
                    limit = max(limit, end)
    return limit


def normalized_segments(body: SubtitlesBody, previous: dict | None, limit: float) -> list[dict]:
    old = {s["id"]: s for s in (previous or {}).get("segments", [])}
    result, seen = [], set()
    for index, segment in enumerate(sorted(body.segments, key=lambda s: (s.start, s.end))):
        prefix = f"{index + 1}. satır"
        if segment.id in seen:
            raise ValueError("Altyazı satır kimlikleri benzersiz olmalı.")
        seen.add(segment.id)
        if segment.end <= segment.start or segment.end > limit + 0.000001:
            raise ValueError(f"{prefix}: başlangıç bitişten önce olmalı ve süre {limit:.3f} sn sınırını aşmamalı.")
        if result and segment.start < result[-1]["end"] - 0.000001:
            raise ValueError(f"{prefix}: altyazı satırları birbiriyle örtüşemez.")
        prev = old.get(segment.id)
        if segment.words is not None:
            words = [word.model_dump() for word in segment.words]
            if " ".join(segment.text.split()) != " ".join(" ".join(w["text"].split()) for w in words):
                raise ValueError(f"{prefix}: kelimeler ile satır metni eşleşmeli.")
        elif prev and prev.get("text") == segment.text and prev.get("start") == segment.start and prev.get("end") == segment.end and prev.get("words"):
            words = [{key: word[key] for key in ("text", "start", "end")} for word in prev["words"]]
        else:
            words = [{"text": word.text, "start": word.start, "end": word.end}
                     for word in distribute_words(segment.text, segment.start, segment.end)]
        last_end = segment.start
        for word in words:
            start, end = word["start"], word["end"]
            if (not math.isfinite(start) or not math.isfinite(end) or not str(word["text"]).strip()
                    or start < last_end - 0.000001 or end <= start or end > segment.end + 0.000001):
                raise ValueError(f"{prefix}: kelime süreleri sıralı, pozitif ve satır sınırları içinde olmalı.")
            last_end = end
        result.append({"id": segment.id, "start": segment.start, "end": segment.end, "text": segment.text, "words": words})
    return result
