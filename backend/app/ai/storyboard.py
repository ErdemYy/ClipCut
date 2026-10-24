"""Single-call, schema-validated scene planner; no videos are generated here."""
from __future__ import annotations

import re

from pydantic import BaseModel, Field

from ..config import get_settings
from ..storyboard import SceneDraft, StoryboardCreateBody, StoryboardInput, revision
from .services import AIError, _client


class _ScenePlan(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    continuity: str = Field("", max_length=1500)
    scenes: list[SceneDraft] = Field(..., min_length=2, max_length=12)


def plan_storyboard(body: StoryboardCreateBody) -> dict:
    if get_settings().is_mock:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", body.brief) if s.strip()]
        labels = {"tr": "Sahne", "en": "Scene", "de": "Szene", "es": "Escena"}
        # Mock is a mechanical draft of the supplied brief, not a claim of AI writing or translation.
        descriptions = []
        for i in range(body.scene_count):
            text = sentences[min(len(sentences) - 1, i * len(sentences) // body.scene_count)]
            descriptions.append(SceneDraft(title=f"{labels[body.language]} {i + 1}",
                                           visual_prompt=f"{text[:1000]}. Shot {i + 1}: {body.style}",
                                           narration=" ".join(text.split()[:body.scene_duration * 2]), duration=body.scene_duration))
        planned = _ScenePlan(title=body.brief[:80], continuity="", scenes=descriptions)
    else:
        from google.genai import types

        prompt = (
            f"Create a cohesive {body.scene_count}-scene video storyboard from the user's topic or script. "
            f"Each scene lasts {body.scene_duration} seconds. Narration language: {body.language}. "
            f"Visual style: {body.style}. Format: {body.aspect_ratio}. "
            "Use a hook, meaningful progression and a closing. Visual prompts must describe concrete shots in English, "
            "with consistent characters, location and art direction defined once in continuity. "
            "Keep narration short enough to speak naturally in its scene, about two words per second. "
            "If a complete script is supplied, preserve its meaning; don't invent unsupported factual claims. "
            "Return only the requested JSON. No shell commands or media URLs.\n\nUser brief:\n" + body.brief
        )
        response = _client().models.generate_content(
            model=body.text_model or get_settings().gemini_text_model, contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=_ScenePlan, temperature=0.4),
        )
        try:
            planned = _ScenePlan.model_validate_json(response.text)
        except ValueError as exc:
            raise AIError("Planlayıcı geçerli bir sahne planı döndürmedi.") from exc
        if len(planned.scenes) != body.scene_count:
            raise AIError("Planlayıcı istenen sahne sayısını döndürmedi; video çağrısı yapılmadı.")
    default_voices = {"tr": "tr-TR-EmelNeural", "en": "en-US-JennyNeural", "de": "de-DE-KillianNeural", "es": "es-ES-AlvaroNeural"}
    data = StoryboardInput(title=planned.title, aspect_ratio=body.aspect_ratio, language=body.language, style=body.style,
                          continuity=planned.continuity, voice_id=default_voices[body.language],
                          scenes=[{**s.model_dump(), "id": revision(), "duration": body.scene_duration} for s in planned.scenes]).model_dump()
    # When the user did not choose a model, keep the spec unset so the
    # configured default stays in effect instead of being frozen at creation.
    data.update({"revision": revision(), "mock_plan": get_settings().is_mock,
                 "text_model": body.text_model, "video_model": body.video_model})
    for scene in data["scenes"]:
        scene["status"] = "pending"
    return data
