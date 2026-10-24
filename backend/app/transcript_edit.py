"""Trusted source-transcript selections; clients never supply media cut times."""
from __future__ import annotations

import hashlib
import json
import math
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .edit.schema import CutRangeOp, EditPlan
from .edit.timeline import MIN_SEGMENT, Timeline, subtract
from .publishing import RenderOptions, Format


class TranscriptSelection(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    segment_ids: list[Annotated[int, Field(strict=True, ge=0)]] = Field(min_length=1, max_length=1000)

    @field_validator("segment_ids")
    @classmethod
    def unique_ids(cls, values):
        return sorted(set(values))


class TranscriptClipBody(TranscriptSelection, RenderOptions):
    aspect_ratio: Format = "9:16"
    fill: str = Field(default="blur", pattern=r"^(blur|fit|crop)$")


def transcript_revision(snapshot: dict) -> str:
    state = {key: snapshot.get(key) for key in ("source_file", "plan", "transcript", "voiceover_file")}
    state["duration"] = float(snapshot.get("duration", 0))
    return hashlib.sha256(json.dumps(state, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def transcript_view(snapshot: dict, timeline: Timeline) -> dict:
    transcript = snapshot.get("transcript") or {}
    reason = None
    # Older standalone TTS transcripts had a top-level words array and no provenance.
    # Keep that conservative guard after deleting a voiceover, not just while it is active.
    if snapshot.get("voiceover_file") or transcript.get("timing_basis") == "voiceover" or (
        "words" in transcript and transcript.get("timing_basis") != "source"
    ):
        reason = "Bu transkript ayrı seslendirmeye ait olabilir. Kaynak videoyu yeniden transkribe edin; ayrı seslendirmeyi de kaldırın."
    rows = []
    duration = float(snapshot.get("duration", 0))
    for index, segment in enumerate(transcript.get("segments", [])):
        try:
            start, end = float(segment["start"]), float(segment["end"])
        except (TypeError, ValueError, KeyError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or not (0 <= start < end <= duration + 0.05):
            continue
        end = min(end, duration)
        if end - start < MIN_SEGMENT:
            continue
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        kept = sum(max(0, min(end, b) - max(start, a)) for a, b in timeline.segments)
        rows.append({"id": index, "start": start, "end": end, "text": text, "kept_duration": kept})
    rows.sort(key=lambda row: (row["start"], row["end"], row["id"]))
    return {"revision": transcript_revision(snapshot), "segments": rows,
            "language": transcript.get("language"), "mock": bool(transcript.get("mock")), "blocked_reason": reason}


def selected_rows(view: dict, selection: TranscriptSelection) -> list[dict]:
    if view["blocked_reason"]:
        raise ValueError(view["blocked_reason"])
    rows = {row["id"]: row for row in view["segments"]}
    if any(index not in rows for index in selection.segment_ids):
        raise ValueError("Geçersiz transkript satırı; transkripti yenileyin.")
    return [row for row in view["segments"] if row["id"] in selection.segment_ids]


def cut_selection(plan: EditPlan, timeline: Timeline, rows: list[dict]) -> EditPlan:
    remaining = list(timeline.segments)
    for row in rows:
        remaining = subtract(remaining, (row["start"], row["end"]))
    remaining = [(a, b) for a, b in remaining if b - a >= MIN_SEGMENT]
    if not remaining:
        # build_timeline deliberately falls back to the full source on an empty plan.
        # Reject BEFORE that fallback, otherwise "remove all" would restore everything.
        raise ValueError("Bu seçim videonun tamamını çıkarır; en az 0.15 sn görüntü bırakın.")
    if remaining == timeline.segments:
        raise ValueError("Seçilen satırlar editte zaten çıkarılmış.")
    return EditPlan(operations=[*plan.operations, *[
        CutRangeOp(start=row["start"], end=row["end"]) for row in rows
    ]])


def clip_selection(view: dict, rows: list[dict]) -> dict:
    if not rows:
        raise ValueError("En az bir transkript satırı seçin.")
    indices = [i for i, row in enumerate(view["segments"]) if row in rows]
    if indices != list(range(indices[0], indices[-1] + 1)):
        raise ValueError("Tek klip için art arda transkript satırları seçin.")
    start = min(row["start"] for row in rows)
    end = max(row["end"] for row in rows)
    if end - start < 0.25:
        raise ValueError("Klip en az 0.25 saniye olmalı.")
    return {"id": 0, "start": start, "end": end}
