"""Storyboard contracts, deterministic cache keys and safe public scene metadata."""
from __future__ import annotations

import hashlib
import json
import math
import uuid
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .ai import tts
from .config import get_settings


class SceneDraft(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    title: str = Field(..., min_length=1, max_length=120)
    visual_prompt: str = Field(..., min_length=3, max_length=2000)
    narration: str = Field("", max_length=1000)
    duration: Literal[4, 6, 8] = 8
    transition: Literal["cut", "dissolve", "fade"] = "cut"
    transition_duration: float = Field(0.6, ge=0.2, le=2.0)


class SceneInput(SceneDraft):
    model_config = ConfigDict(allow_inf_nan=False)
    id: str = Field(..., pattern=r"^[a-f0-9]{12}$")
    trim_start: float = Field(0, ge=0, le=30)
    trim_end: float | None = Field(None, ge=0, le=30)

    @model_validator(mode="after")
    def valid_trim(self):
        if self.trim_end is not None and self.trim_end - self.trim_start < 0.25 - 1e-6:
            raise ValueError("Sahnede en az 0.25 saniye kalmalı.")
        return self


class StoryboardInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    title: str = Field(..., min_length=1, max_length=120)
    aspect_ratio: Literal["9:16", "16:9"] = "9:16"
    language: Literal["tr", "en", "de", "es"] = "tr"
    style: str = Field("cinematic, natural lighting", min_length=1, max_length=500)
    continuity: str = Field("", max_length=1500)
    voiceover: bool = True
    voice_id: str = "tr-TR-EmelNeural"
    auto_subtitles: bool = True
    # Model secimi endpoint'te dogrulanir; eski projelerde alan yoksa etkin varsayilan kullanilir.
    text_model: Optional[str] = Field(None, max_length=128)
    video_model: Optional[str] = Field(None, max_length=128)
    scenes: list[SceneInput] = Field(..., min_length=2, max_length=12)

    @model_validator(mode="after")
    def valid_scenes_and_voice(self):
        if len({s.id for s in self.scenes}) != len(self.scenes):
            raise ValueError("Sahne kimlikleri benzersiz olmalı.")
        if self.voiceover:
            voice = tts.get_voice(self.voice_id)
            if not voice or voice["language"] != self.language:
                raise ValueError("Seslendirme sesi seçilen dil ile eşleşmeli.")
            if any(not s.narration for s in self.scenes):
                raise ValueError("Seslendirme açıkken her sahnenin anlatım metni olmalı.")
        return self


class StoryboardCreateBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    brief: str = Field(..., min_length=3, max_length=6000)
    scene_count: int = Field(4, ge=2, le=12)
    scene_duration: Literal[4, 6, 8] = 8
    aspect_ratio: Literal["9:16", "16:9"] = "9:16"
    language: Literal["tr", "en", "de", "es"] = "tr"
    style: str = Field("cinematic, natural lighting", min_length=1, max_length=500)
    text_model: Optional[str] = Field(None, max_length=128)
    video_model: Optional[str] = Field(None, max_length=128)
    max_cost_usd: Optional[float] = Field(None, ge=0, le=10000)
    confirm_api_usage: bool = False


class StoryboardSaveBody(StoryboardInput):
    revision: str = Field(..., pattern=r"^[a-f0-9]{12}$")


class StoryboardGenerateBody(BaseModel):
    revision: str = Field(..., pattern=r"^[a-f0-9]{12}$")
    scene_id: str | None = Field(None, pattern=r"^[a-f0-9]{12}$")
    confirm_api_usage: bool = False
    confirm_replace_source: bool = False
    # Istege bagli sert ust sinir. Sunucu, saglayici cagrisindan once tahmini hesaplar.
    max_cost_usd: Optional[float] = Field(None, ge=0, le=10000)


def revision() -> str:
    return uuid.uuid4().hex[:12]


def fingerprint(spec: dict, scene: dict) -> str:
    settings = get_settings()
    data = {
        "scene": SceneInput.model_validate(scene).model_dump(exclude={"title", "trim_start", "trim_end", "transition", "transition_duration"}),
        "aspect_ratio": spec["aspect_ratio"], "style": spec["style"], "continuity": spec.get("continuity", ""),
        "language": spec["language"], "voiceover": spec["voiceover"],
        "voice_id": spec["voice_id"] if spec["voiceover"] else None,
        "mock": settings.is_mock, "model": spec.get("video_model") or settings.veo_model, "pipeline": 1,
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


def visual_fingerprint(spec: dict, scene: dict) -> str:
    settings = get_settings()
    data = {"prompt": scene["visual_prompt"], "duration": scene["duration"], "style": spec["style"],
            "continuity": spec.get("continuity", ""), "aspect": spec["aspect_ratio"],
            "no_dialogue": spec["voiceover"], "mock": settings.is_mock,
            "model": spec.get("video_model") or settings.veo_model, "pipeline": 1}
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


def scene_file(project_id: str, relative: str | None) -> Path | None:
    """Runtime paths are server-authored, but still validate before serving/reusing."""
    if not relative:
        return None
    root = (get_settings().storage_dir / "projects" / project_id).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root / "storyboard") or not path.is_file():
        return None
    return path


def scene_ready(project_id: str, spec: dict, scene: dict) -> bool:
    return (scene.get("status") == "ready" and scene.get("fingerprint") == fingerprint(spec, scene)
            and scene_file(project_id, scene.get("file")) is not None)


def trim_range(scene: dict, duration: float | None = None) -> tuple[float, float]:
    duration = float(duration if duration is not None else scene.get("actual_duration") or scene["duration"])
    start = float(scene.get("trim_start", 0))
    end = float(scene["trim_end"]) if scene.get("trim_end") is not None else duration
    if not all(math.isfinite(v) for v in (start, end, duration)) or start < 0 or end > duration + 1e-6 or end - start < 0.25 - 1e-6:
        raise ValueError("Kırpma aralığı sahne sınırları içinde olmalı ve en az 0.25 saniye bırakmalı.")
    return start, min(end, duration)


def transition_overlap(previous: float, current: float, scene: dict) -> float:
    """Effective overlap for a scene transition, capped so short scenes keep solo frames."""
    if scene.get("transition", "cut") not in ("dissolve", "fade"):
        return 0.0
    requested = float(scene.get("transition_duration", 0.6))
    if not math.isfinite(requested):
        return 0.0
    overlap = min(requested, 2.0, previous * 0.4, current * 0.4)
    return round(overlap, 3) if overlap >= 0.2 else 0.0


def trim_transcript_segments(transcript: dict | None, start: float, end: float, offset: float) -> list[dict]:
    """Clip word intervals to scene-local trim bounds and shift to assembled time."""
    from .subtitles.builder import distribute_words

    segments = []
    for seg in (transcript or {}).get("segments", []):
        words = []
        source_words = seg.get("words") or [w.__dict__ for w in distribute_words(seg.get("text", ""), seg["start"], seg["end"])]
        for word in source_words:
            a, b = max(start, word["start"]), min(end, word["end"])
            if b - a > 0.01:
                words.append({**word, "start": round(offset + a - start, 3), "end": round(offset + b - start, 3)})
        if words:
            segments.append({"start": words[0]["start"], "end": words[-1]["end"],
                             "text": " ".join(w["text"] for w in words), "words": words})
    return segments


def public_storyboard(project_id: str, spec: dict | None) -> dict | None:
    if not spec:
        return None
    data = StoryboardInput.model_validate(spec).model_dump()
    settings = get_settings()
    data.update({"revision": spec["revision"], "assembled_revision": spec.get("assembled_revision"),
                 "mock_plan": spec.get("mock_plan", False), "last_error": spec.get("last_error"),
                 "text_model": spec.get("text_model") or settings.gemini_text_model,
                 "video_model": spec.get("video_model") or settings.veo_model})
    for public, scene in zip(data["scenes"], spec["scenes"]):
        ready = scene_ready(project_id, spec, scene)
        public.update({"status": "ready" if ready else (scene.get("status") if scene.get("status") in {"generating", "failed"} else "pending"),
                       "video_url": f"/media/projects/{project_id}/{scene['file']}" if ready else None,
                       "thumbnail_url": f"/api/projects/{project_id}/storyboard/scenes/{scene['id']}/thumbnail?v={Path(scene['file']).parent.name}" if ready else None,
                       "actual_duration": scene.get("actual_duration") if ready else None,
                       "timeline_duration": round(trim_range(scene)[1] - trim_range(scene)[0], 3) if ready else scene["duration"],
                       "error": scene.get("error"), "mock": scene.get("mock") if ready else None})
    data["pending_scenes"] = sum(s["status"] != "ready" for s in data["scenes"])
    data["planned_duration"] = sum(s["duration"] for s in data["scenes"])
    timeline, previous_length = 0.0, 0.0
    for i, scene in enumerate(data["scenes"]):
        if i:
            timeline -= transition_overlap(previous_length, scene["timeline_duration"], scene)
        timeline += scene["timeline_duration"]
        previous_length = scene["timeline_duration"]
    data["timeline_duration"] = round(timeline, 3)
    data["previous_versions"] = [{"index": i, "source_url": f"/media/projects/{project_id}/{v['source_file']}",
                                  "created_at": v["created_at"],
                                  "restorable": isinstance(v.get("spec"), dict) and bool(v["spec"].get("scenes")),
                                  "has_plan": bool(v.get("plan"))}
                                 for i, v in enumerate(spec.get("previous_versions", []))]
    return data


def merge_saved_spec(old: dict, edited: StoryboardSaveBody) -> dict:
    """Only editor fields are accepted; clients cannot inject file/cache/status fields."""
    data = StoryboardInput.model_validate(edited.model_dump()).model_dump()
    # Eski istemciler model alanlarini gondermezse kayitli secimi silme.
    data["text_model"] = data.get("text_model") or old.get("text_model")
    data["video_model"] = data.get("video_model") or old.get("video_model")
    # The first scene has no incoming edge.
    data["scenes"][0]["transition"] = "cut"
    previous = {s["id"]: s for s in old["scenes"]}
    for scene in data["scenes"]:
        prior = previous.get(scene["id"])
        if scene["trim_start"] != 0 or scene["trim_end"] is not None:
            if (not prior or prior.get("status") != "ready" or not prior.get("actual_duration")
                    or prior.get("fingerprint") != fingerprint(old, prior) or fingerprint(data, scene) != fingerprint(old, prior)):
                raise ValueError("Kırpma yalnızca hazır ve değişmemiş sahnelerde yapılabilir. Üretim ayarı değiştiyse önce kırpmayı sıfırlayın.")
            trim_range(scene, prior["actual_duration"])
        if prior and fingerprint(data, scene) == fingerprint(old, prior):
            scene.update({k: prior[k] for k in ("status", "fingerprint", "raw_file", "raw_fingerprint", "file", "actual_duration", "transcript", "mock", "error") if k in prior})
        else:
            scene["status"] = "pending"
            if prior and visual_fingerprint(data, scene) == visual_fingerprint(old, prior):
                scene.update({k: prior[k] for k in ("raw_file", "raw_fingerprint") if k in prior})
    data.update({"revision": revision(), "assembled_revision": old.get("assembled_revision"),
                 "mock_plan": old.get("mock_plan", False), "previous_versions": old.get("previous_versions", []),
                 "source_spec": old.get("source_spec")})
    return data
