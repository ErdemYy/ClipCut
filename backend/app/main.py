"""ClipCut FastAPI uygulaması."""
from __future__ import annotations

import copy
import logging
import shutil
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from sqlmodel import Session, select

from . import assets, jobs
from .ai import broll, catalog as ai_catalog, services as ai, tts
from .config import get_settings
from .edit.schema import EditPlan, OverlayOp, SubtitlesOp, dsl_reference
from .edit.layers import LayerTimingsBody, timeline_revision, update_layer_timings
from .edit.templates import TEMPLATES, get_template
from .ffmpeg import ffmpeg_exe, make_thumbnail, probe
from .models import Job, Project, get_session, init_db
from .publishing import BatchExportBody, ClipAnalyzeBody, ClipExportBody, ClipPreviewBody, PreviewBody, RenderOptions, ThumbnailBody, clip_cover_time, preview_window
from .storyboard import (StoryboardCreateBody, StoryboardGenerateBody, StoryboardSaveBody,
                         merge_saved_spec, public_storyboard, scene_ready)
from .storyboard import scene_file
from .storyboard_jobs import task_generate_storyboard
from .subtitles.builder import cues_for_export, map_words, to_srt, to_vtt, transcript_words
from .subtitles.editor import SubtitlesBody, normalized_segments, subtitle_revision, subtitle_time_limit
from .transcript_edit import (TranscriptClipBody, TranscriptSelection, clip_selection, cut_selection,
                              selected_rows, transcript_revision, transcript_view)
from .waveform import SourceChangedError, source_waveform

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings = get_settings()
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
_storyboard_lock = threading.Lock()
_layer_edit_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    threading.Thread(target=assets.ensure_assets, daemon=True).start()
    yield


app = FastAPI(title="ClipCut API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
settings.assets_dir.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=settings.storage_dir), name="media")
app.mount("/assets", StaticFiles(directory=settings.assets_dir), name="assets")


# ------------------------------------------------------------------ yardımcılar ----

def serialize(p: Project, full: bool = True) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": p.id, "name": p.name, "status": p.status, "origin": p.origin,
        "created_at": p.created_at.isoformat(), "updated_at": p.updated_at.isoformat(),
        "duration": p.duration, "width": p.width, "height": p.height, "has_audio": p.has_audio,
        "source_url": jobs.media_url(p.id, p.source_file), "thumbnail_url": jobs.media_url(p.id, p.thumbnail_file),
        "voiceover_url": jobs.media_url(p.id, p.voiceover_file), "has_voiceover": bool(p.voiceover_file),
        "output_url": jobs.media_url(p.id, p.output_file), "subtitle_language": p.subtitle_language,
        "has_transcript": bool(p.transcript), "has_subtitles": bool(p.subtitles),
        "operation_count": len(p.plan.get("operations", [])),
    }
    if p.storyboard:
        scenes = p.storyboard.get("scenes", [])
        data["storyboard_progress"] = {
            "ready": sum(1 for s in scenes if s.get("status") == "ready"),
            "total": len(scenes),
            "assembled": p.storyboard.get("assembled_revision") == p.storyboard.get("revision"),
        }
    if full:
        data.update({
            "generation_prompt": p.generation_prompt, "transcript_language": (p.transcript or {}).get("language"),
            "subtitles": p.subtitles, "plan": p.plan, "can_undo": bool(p.plan_history), "chat": p.chat,
            "output_meta": p.output_meta,
            "render_revision": jobs.render_revision(p),
            "subtitle_revision": subtitle_revision(p.model_dump()),
            "subtitle_time_limit": subtitle_time_limit(p.model_dump()),
            "timeline_revision": timeline_revision(p.model_dump()),
            "storyboard": public_storyboard(p.id, p.storyboard),
        })
    return data


def get_project(project_id: str, session: Session) -> Project:
    p = session.get(Project, project_id)
    if not p:
        raise HTTPException(404, "Proje bulunamadı")
    return p


def touch(p: Project) -> None:
    p.updated_at = datetime.now(timezone.utc)


def job_dict(j: Job) -> dict[str, Any]:
    return j.model_dump(mode="json")


# ------------------------------------------------------------------ genel ----

@app.get("/api/health")
@app.get("/health")
def health() -> dict:
    try:
        ff = ffmpeg_exe()
    except Exception as exc:
        ff = f"HATA: {exc}"
    return {"ok": True, "mock": settings.is_mock, "ffmpeg": ff, "veo_model": settings.veo_model,
            "text_model": settings.gemini_text_model, **ai.video_model_constraints()}


@app.get("/api/ai/models")
def ai_models() -> dict:
    """Selectable models and the pricing snapshot used for pre-generation estimates."""
    return ai_catalog.model_catalog()


class PreflightBody(BaseModel):
    video_model: Optional[str] = Field(None, max_length=128)
    text_model: Optional[str] = Field(None, max_length=128)
    scene_durations: list[int] = Field(default_factory=list, max_length=24)
    voiceover: bool = False
    planning_scene_count: int = Field(0, ge=0, le=12)
    planning_chars: int = Field(0, ge=0, le=20000)


@app.post("/api/ai/preflight")
def ai_preflight(body: PreflightBody) -> dict:
    """Estimate provider cost WITHOUT calling any AI or starting a job."""
    try:
        return ai_catalog.preflight(
            video_model=body.video_model, text_model=body.text_model,
            scene_durations=body.scene_durations, voiceover=body.voiceover,
            planning_scene_count=body.planning_scene_count, planning_chars=body.planning_chars,
        )
    except (ai_catalog.UnknownModel, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/library")
def library() -> dict:
    return {
        "music": assets.list_library("music"), "sfx": assets.list_library("sfx"), "fonts": assets.FONT_FAMILIES,
        "broll": broll.list_stock_broll(),
        "languages": [{"code": k, "name": v} for k, v in ai.LANGUAGES.items()],
        "subtitle_styles": ["karaoke", "word_pop", "hormozi", "neon", "classic", "boxed", "minimal"],
        "color_presets": ["none", "cinematic", "vibrant", "warm", "cool", "bw", "vintage", "moody", "bright"],
        "transitions": ["fade", "dissolve", "fadeblack", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "smoothleft", "zoomin"],
        "dsl": dsl_reference(),
    }


@app.get("/api/templates")
def list_templates() -> list[dict]:
    return TEMPLATES


@app.get("/api/voices")
def list_voices() -> list[dict]:
    return tts.list_voices()


@app.post("/api/projects/{project_id}/apply-template/{template_id}")
def apply_template(project_id: str, template_id: str, session: Session = Depends(get_session)) -> dict:
    tmpl = get_template(template_id)
    if not tmpl:
        raise HTTPException(404, "Şablon bulunamadı")
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    plan = EditPlan.model_validate(tmpl["plan"])
    _set_plan(p, plan)
    now = datetime.now(timezone.utc).isoformat()
    summary = f"'{tmpl['name']}' şablonu uygulandı: {tmpl['description']}"
    p.chat = [*p.chat, {"role": "assistant", "text": summary, "at": now, "changed": True}][-100:]
    session.add(p)
    session.commit()
    session.refresh(p)
    return {"summary": summary, "project": serialize(p)}


# ------------------------------------------------------------------ projeler ----

@app.get("/api/projects")
def list_projects(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.exec(select(Project).order_by(Project.updated_at.desc())).all()  # type: ignore[attr-defined]
    return [serialize(p, full=False) for p in rows]


@app.post("/api/projects/upload")
def upload_project(file: UploadFile = File(...), name: str = Form(""), session: Session = Depends(get_session)) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"Desteklenmeyen dosya türü: {ext or '?'}")
    p = Project(name=name.strip() or Path(file.filename or "Video").stem, origin="upload")
    pdir = jobs.project_dir(p.id)
    dst = pdir / f"source{ext}"
    with dst.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        jobs.ingest_source(p, dst)
    except Exception as exc:
        shutil.rmtree(pdir, ignore_errors=True)
        raise HTTPException(400, f"Video okunamadı: {exc}") from exc
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


class GenerateBody(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=2000)
    name: str = ""
    aspect_ratio: Literal["16:9", "9:16"] = "16:9"
    duration: int = Field(8, ge=4, le=8)
    negative_prompt: Optional[str] = None
    video_model: Optional[str] = Field(None, max_length=128)
    max_cost_usd: Optional[float] = Field(None, ge=0, le=10000)


@app.exception_handler(jobs.DuplicateJobError)
async def duplicate_job_handler(_request: Any, exc: jobs.DuplicateJobError) -> PlainTextResponse:
    # Any double submission (transcribe/translate/render/export/generate) maps to a clean 409.
    return PlainTextResponse(str(exc), status_code=409, media_type="text/plain; charset=utf-8")


@app.post("/api/projects/generate")
def generate_project(body: GenerateBody, session: Session = Depends(get_session)) -> dict:
    try:
        model = ai_catalog.resolve_video_model(body.video_model)
    except ai_catalog.UnknownModel as exc:
        raise HTTPException(422, str(exc)) from exc
    if body.duration not in model.durations:
        raise HTTPException(422, f"{model.label} için 8 saniyelik sahne seçin.")
    if body.max_cost_usd is not None:
        estimate = ai_catalog.preflight(video_model=model.id, scene_durations=[body.duration])
        blocked = ai_catalog.budget_error(estimate, body.max_cost_usd)
        if blocked:
            raise HTTPException(422, blocked)
    p = Project(name=body.name.strip() or body.prompt[:48], origin="veo", status="generating", generation_prompt=body.prompt)
    session.add(p)
    session.commit()
    session.refresh(p)
    job = jobs.submit(p.id, "generate", jobs.task_generate, p.id, body.prompt, body.aspect_ratio,
                      body.duration, body.negative_prompt, model.id)
    return {"project": serialize(p), "job": job_dict(job)}


@app.get("/api/projects/{project_id}")
def read_project(project_id: str, session: Session = Depends(get_session)) -> dict:
    return serialize(get_project(project_id, session))


# --------------------------------------------------------- senaryodan çok sahne ----

@app.post("/api/projects/storyboard")
def create_storyboard(body: StoryboardCreateBody, session: Session = Depends(get_session)) -> dict:
    if not settings.is_mock and not body.confirm_api_usage:
        raise HTTPException(422, "Gerçek AI planlama çağrısı ücretli olabilir; açık onay gerekli.")
    try:
        video_model = ai_catalog.resolve_video_model(body.video_model)
        text_model = ai_catalog.resolve_text_model(body.text_model)
    except ai_catalog.UnknownModel as exc:
        raise HTTPException(422, str(exc)) from exc
    if body.scene_duration not in video_model.durations:
        raise HTTPException(422, f"{video_model.label} için 8 saniyelik sahne seçin.")
    if body.max_cost_usd is not None:
        estimate = ai_catalog.preflight(
            video_model=video_model.id, text_model=text_model.id,
            planning_scene_count=body.scene_count, planning_chars=len(body.brief),
        )
        blocked = ai_catalog.budget_error(estimate, body.max_cost_usd)
        if blocked:
            raise HTTPException(422, blocked)
    from .ai.storyboard import plan_storyboard

    try:
        spec = plan_storyboard(body)
    except Exception as exc:
        raise HTTPException(502, f"Sahne planı oluşturulamadı: {exc}") from exc
    p = Project(name=spec["title"], origin="storyboard", status="draft", generation_prompt=body.brief, storyboard=spec)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.put("/api/projects/{project_id}/storyboard")
def save_storyboard(project_id: str, body: StoryboardSaveBody, session: Session = Depends(get_session)) -> dict:
    with _storyboard_lock:
        p = get_project(project_id, session)
        session.refresh(p)
        if not p.storyboard:
            raise HTTPException(409, "Projede sahne planı yok.")
        if p.status == "generating":
            raise HTTPException(409, "Üretim sürerken sahne planı değiştirilemez.")
        if body.revision != p.storyboard["revision"]:
            raise HTTPException(409, "Sahne planı başka bir oturumda değişti; sayfayı yenileyin.")
        try:
            # Yalnızca değiştirilen model kimliği doğrulanır; eski kayıttaki bir model
            # yapılandırmadan çıkarılmış olsa bile projeyi kilitlemeyiz.
            old = p.storyboard
            if body.text_model and body.text_model != old.get("text_model"):
                ai_catalog.resolve_text_model(body.text_model)
            if body.video_model and body.video_model != old.get("video_model"):
                ai_catalog.resolve_video_model(body.video_model)
            p.storyboard = merge_saved_spec(p.storyboard, body)
        except (ai_catalog.UnknownModel, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        p.name = body.title
        touch(p)
        session.add(p)
        session.commit()
        session.refresh(p)
        return serialize(p)


@app.get("/api/projects/{project_id}/storyboard/scenes/{scene_id}/thumbnail")
def scene_thumbnail(project_id: str, scene_id: str, session: Session = Depends(get_session)):
    p = get_project(project_id, session)
    scene = next((s for s in (p.storyboard or {}).get("scenes", []) if s["id"] == scene_id), None)
    if not scene or not scene_ready(p.id, p.storyboard, scene):
        raise HTTPException(404, "Hazır sahne bulunamadı.")
    source = scene_file(p.id, scene["file"])
    if source is None:
        raise HTTPException(404, "Sahne dosyası bulunamadı.")
    thumb = source.with_suffix(".thumb.jpg")
    if not thumb.exists():
        temp = source.parent / f"thumb_{uuid.uuid4().hex}.jpg"
        try:
            make_thumbnail(source, temp, at=0)
            temp.replace(thumb)
        finally:
            temp.unlink(missing_ok=True)
    return FileResponse(thumb, media_type="image/jpeg")


@app.post("/api/projects/{project_id}/storyboard/generate")
def generate_storyboard(project_id: str, body: StoryboardGenerateBody, session: Session = Depends(get_session)) -> dict:
    with _storyboard_lock:
        p = get_project(project_id, session)
        session.refresh(p)
        spec = p.storyboard
        if not spec:
            raise HTTPException(409, "Önce sahne planı oluşturun.")
        if p.status == "generating":
            raise HTTPException(409, "Bu proje zaten üretim sırasında.")
        if spec["revision"] != body.revision:
            raise HTTPException(409, "Sahne planı değişti; sayfayı yenileyin.")
        if body.scene_id and body.scene_id not in {s["id"] for s in spec["scenes"]}:
            raise HTTPException(422, "Seçilen sahne bu projeye ait değil.")
        pending = [s for s in spec["scenes"] if s["id"] == body.scene_id] if body.scene_id else [s for s in spec["scenes"] if not scene_ready(p.id, spec, s)]
        constraints = ai.video_model_constraints(spec.get("video_model"))
        if any(s["duration"] not in constraints["video_durations"] for s in pending):
            raise HTTPException(422, "Seçili video modeli için sahne süresini 8 saniye seçip planı kaydedin.")
        if pending and body.max_cost_usd is not None:
            try:
                estimate = ai_catalog.preflight(
                    video_model=spec.get("video_model"), text_model=spec.get("text_model"),
                    scene_durations=[s["duration"] for s in pending], voiceover=spec.get("voiceover", False),
                )
            except (ai_catalog.UnknownModel, ValueError) as exc:
                raise HTTPException(422, f"Üretim öncesi maliyet doğrulanamadı: {exc}") from exc
            blocked = ai_catalog.budget_error(estimate, body.max_cost_usd)
            if blocked:
                raise HTTPException(422, blocked)
        if pending and not settings.is_mock and not body.confirm_api_usage:
            raise HTTPException(422, f"{len(pending)} sahne için gerçek video/ses API kullanımı onayı gerekli.")
        if p.source_file and not body.confirm_replace_source:
            raise HTTPException(422, "Yeni birleştirme edit kaynağını değiştirir; önceki sürümü koruyarak değiştirme onayı gerekli.")
        previous_status = p.status
        p.status = "generating"
        touch(p)
        session.add(p)
        session.commit()
        try:
            job = jobs.submit(p.id, "storyboard_generate", task_generate_storyboard, p.id, body.scene_id, cancellable=True)
        except Exception as exc:
            p.status = previous_status
            session.add(p)
            session.commit()
            raise HTTPException(503, "Üretim kuyruğu başlatılamadı.") from exc
        return job_dict(job)


class StoryboardRestoreBody(BaseModel):
    version_index: int
    confirm: bool


@app.post("/api/projects/{project_id}/storyboard/restore")
def restore_storyboard_version(project_id: str, body: StoryboardRestoreBody, session: Session = Depends(get_session)) -> dict:
    """Restore a protected version: its source video, editor state and scene plan."""
    with _storyboard_lock:
        p = get_project(project_id, session)
        session.refresh(p)
        if not p.storyboard:
            raise HTTPException(409, "Bu projede sahne planı yok.")
        if p.status == "generating":
            raise HTTPException(409, "Üretim sürüyor; bitmesini bekleyin.")
        if not body.confirm:
            raise HTTPException(422, "Geri yükleme mevcut kaynak ve edit durumunu değiştirir; açık onay gerekli.")
        spec = copy.deepcopy(p.storyboard)
        versions = list(spec.get("previous_versions", []))
        if not 0 <= body.version_index < len(versions):
            raise HTTPException(404, "Geri yüklenecek sürüm bulunamadı.")
        target = versions[body.version_index]
        if not (isinstance(target.get("spec"), dict) and target["spec"].get("scenes")):
            raise HTTPException(422, "Bu sürüm eski arşiv biçiminde; sadece video bağlantısı kullanılabilir, geri yükleme yapılamaz.")
        source_path = jobs.project_dir(p.id) / target["source_file"]
        if not source_path.exists():
            raise HTTPException(409, "Korunan video dosyası diskte bulunamadı; geri yükleme yapılamaz.")
        info = probe(source_path)
        if not info.has_video:
            raise HTTPException(409, "Korunan video dosyası geçersiz; geri yükleme yapılamaz.")

        # The pre-restore state is archived so the action is reversible.
        if p.source_file:
            current = {"created_at": datetime.now(timezone.utc).isoformat(), "source_file": p.source_file,
                       "plan": p.plan, "plan_history": p.plan_history, "transcript": p.transcript,
                       "subtitles": p.subtitles, "subtitle_language": p.subtitle_language,
                       "output_file": p.output_file, "output_meta": p.output_meta,
                       "thumbnail_file": p.thumbnail_file, "voiceover_file": p.voiceover_file,
                       "spec": copy.deepcopy(spec.get("source_spec")) if isinstance(spec.get("source_spec"), dict) else None}
        else:
            current = None
        kept = [v for i, v in enumerate(versions) if i != body.version_index]
        new_versions = [*kept, current][:6] if current else kept

        restored = copy.deepcopy(target["spec"])
        restored["source_spec"] = copy.deepcopy(restored)  # The media matches this spec again.
        restored["previous_versions"] = new_versions
        restored["assembled_revision"] = restored.get("revision")
        restored["last_error"] = None

        def update(proj: Project):
            proj.source_file = target["source_file"]
            proj.thumbnail_file = target.get("thumbnail_file")
            proj.plan = target.get("plan")
            proj.plan_history = target.get("plan_history") or []
            proj.transcript = target.get("transcript")
            proj.subtitles = target.get("subtitles")
            proj.subtitle_language = target.get("subtitle_language")
            proj.output_file = target.get("output_file")
            proj.output_meta = target.get("output_meta")
            proj.voiceover_file = target.get("voiceover_file")
            proj.duration, proj.width, proj.height, proj.has_audio = info.duration, info.width, info.height, info.has_audio
            proj.status = "ready"
            proj.storyboard = restored

        jobs._save_project(p.id, update)
        return serialize(jobs._load(p.id))


class PatchBody(BaseModel):
    name: Optional[str] = None


@app.patch("/api/projects/{project_id}")
def patch_project(project_id: str, body: PatchBody, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if body.name:
        p.name = body.name.strip()[:120]
    touch(p)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    session.delete(p)
    for j in session.exec(select(Job).where(Job.project_id == project_id)).all():
        session.delete(j)
    session.commit()
    shutil.rmtree(settings.storage_dir / "projects" / project_id, ignore_errors=True)
    return {"ok": True}


# ------------------------------------------------------------------ işler ----

@app.get("/api/jobs/{job_id}")
def read_job(job_id: str, session: Session = Depends(get_session)) -> dict:
    j = session.get(Job, job_id)
    if not j:
        raise HTTPException(404, "İş bulunamadı")
    return job_dict(j)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, session: Session = Depends(get_session)) -> dict:
    j = session.get(Job, job_id)
    if not j:
        raise HTTPException(404, "İş bulunamadı")
    # Other job kinds still run to completion; stopping mid-render would only create orphan files.
    if j.kind != "storyboard_generate":
        raise HTTPException(409, "Bu işlem türü güvenli şekilde durdurulamaz.")
    if j.status not in ("queued", "running"):
        raise HTTPException(409, "İş artık sürmüyor.")
    if not jobs.cancel(job_id):
        raise HTTPException(409, "İş tamamlanmış; durdurulamaz.")
    session.refresh(j)
    return job_dict(j)


@app.get("/api/projects/{project_id}/jobs")
def project_jobs(project_id: str, session: Session = Depends(get_session)) -> list[dict]:
    rows = session.exec(select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc()).limit(20)).all()  # type: ignore[attr-defined]
    return [job_dict(j) for j in rows]


# ------------------------------------------------------------------ altyazı ----

class TranscribeBody(BaseModel):
    target_language: Optional[str] = None


@app.post("/api/projects/{project_id}/transcribe")
def transcribe(project_id: str, body: TranscribeBody, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    return job_dict(jobs.submit(p.id, "transcribe", jobs.task_transcribe, p.id, body.target_language))


class TranslateBody(BaseModel):
    target_language: str


@app.post("/api/projects/{project_id}/translate")
def translate(project_id: str, body: TranslateBody, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if not p.transcript:
        raise HTTPException(409, "Önce altyazı oluşturun.")
    return job_dict(jobs.submit(p.id, "translate", jobs.task_translate, p.id, body.target_language))


@app.put("/api/projects/{project_id}/subtitles")
def update_subtitles(project_id: str, body: SubtitlesBody, session: Session = Depends(get_session)) -> dict:
    """Keep explicit word timings; only legacy changed-text requests redistribute words."""
    p = ready_source(project_id, session)
    snapshot = p.model_dump()
    if body.revision is not None and body.revision != subtitle_revision(snapshot):
        raise HTTPException(409, "Kaynak veya altyazılar değişti; güncel altyazıyı yükleyip tekrar düzenleyin.")
    active = session.exec(select(Job).where(Job.project_id == p.id,
        Job.kind.in_(("transcribe", "translate", "storyboard_generate")),
        Job.status.in_(("queued", "running")))).first()
    if active:
        raise HTTPException(409, "Altyazıyı değiştiren işlem sürüyor; tamamlanmasını bekleyin.")
    try:
        segments = normalized_segments(body, p.subtitles, subtitle_time_limit(snapshot))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    p.subtitles = {**(p.subtitles or {}), "language": p.subtitle_language or (p.subtitles or {}).get("language") or "und", "segments": segments,
                   "edited": True, "manual_segments": True}
    touch(p)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.get("/api/projects/{project_id}/subtitles.{fmt}")
def export_subtitles(project_id: str, fmt: Literal["srt", "vtt"], edited: bool = True, session: Session = Depends(get_session)):
    p = get_project(project_id, session)
    if not p.subtitles:
        raise HTTPException(404, "Altyazı yok.")
    words = transcript_words(p.subtitles)
    if edited:
        words = map_words(words, jobs.project_timeline(p))
    cues = cues_for_export(words)
    body = to_srt(cues) if fmt == "srt" else to_vtt(cues)
    filename = f"{p.name}_{p.subtitle_language or 'sub'}.{fmt}".replace(" ", "_")
    # Header values are latin-1; non-ASCII names (Turkish) need the RFC 5987 UTF-8 form.
    ascii_fallback = "".join(c if (c.isascii() and (c.isalnum() or c in "-._")) else "_" for c in filename)
    utf8_name = quote(filename, safe="!#$&+-.^_`|~")
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8",
                             headers={"Content-Disposition":
                                      f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{utf8_name}"})


# ------------------------------------------------------------------ edit planı ----

class EditBody(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)


def _context(p: Project) -> dict:
    tl = jobs.project_timeline(p)
    segs = (p.subtitles or p.transcript or {}).get("segments", [])
    return {
        "duration": round(p.duration, 2), "output_duration": round(tl.output_duration, 2),
        "width": p.width, "height": p.height, "has_audio": p.has_audio,
        "transcript": [{"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"]} for s in segs][:400],
        "music_library": [{"id": m["id"], "mood": m["mood"]} for m in assets.list_library("music")],
        "sfx_library": [m["id"] for m in assets.list_library("sfx")],
        "project_audio": [f"project:{f.name}" for f in (jobs.project_dir(p.id) / "audio").glob("*")] if (jobs.project_dir(p.id) / "audio").exists() else [],
        "fonts": assets.FONT_FAMILIES,
    }


def _set_plan(p: Project, plan: EditPlan) -> None:
    p.plan_history = [*p.plan_history, p.plan][-50:]
    p.plan = plan.model_dump()
    touch(p)


@app.post("/api/projects/{project_id}/edit")
def edit_with_prompt(project_id: str, body: EditBody, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    current = EditPlan.model_validate(p.plan)
    try:
        plan, summary = ai.plan_edit(body.prompt, current, _context(p))
    except Exception as exc:
        raise HTTPException(502, f"Planlayıcı hatası: {exc}") from exc
    changed = plan.model_dump() != current.model_dump()
    if changed:
        _set_plan(p, plan)
    now = datetime.now(timezone.utc).isoformat()
    p.chat = [*p.chat, {"role": "user", "text": body.prompt, "at": now},
              {"role": "assistant", "text": summary, "at": now, "changed": changed}][-100:]
    session.add(p)
    session.commit()
    session.refresh(p)
    return {"summary": summary, "changed": changed, "project": serialize(p)}


class PlanBody(BaseModel):
    plan: dict[str, Any]


@app.put("/api/projects/{project_id}/plan")
def put_plan(project_id: str, body: PlanBody, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    try:
        plan = EditPlan.model_validate(body.plan)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_url=False)) from exc
    _set_plan(p, plan)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.post("/api/projects/{project_id}/plan/undo")
def undo_plan(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if not p.plan_history:
        raise HTTPException(409, "Geri alınacak adım yok.")
    history = list(p.plan_history)
    p.plan = history.pop()
    p.plan_history = history
    touch(p)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.get("/api/projects/{project_id}/timeline")
def timeline(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    value = jobs.project_timeline(p)
    return {**value.to_dict(), "exact_output_duration": value.output_duration, "revision": timeline_revision(p.model_dump())}


@app.patch("/api/projects/{project_id}/timeline/layers")
def edit_timeline_layers(project_id: str, body: LayerTimingsBody, session: Session = Depends(get_session)) -> dict:
    # One process-local critical section for revision check + plan/history update.
    # Two editor tabs must not both accept the same old layer revision.
    with _layer_edit_lock:
        p = ready_source(project_id, session)
        if body.revision != timeline_revision(p.model_dump()):
            raise HTTPException(409, "Kaynak veya edit planı değişti; güncel zaman çizelgesini yükleyin.")
        current = EditPlan.model_validate(p.plan)
        if len(current.operations) != len(p.plan.get("operations", [])):
            raise HTTPException(409, "Edit planında yinelenen tekil işlemler var; AI Edit panelinde düzeltip yenileyin.")
        try:
            plan = update_layer_timings(current, body, jobs.project_timeline(p, current).output_duration)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if plan.model_dump() != current.model_dump():
            _set_plan(p, plan)
            session.add(p)
            session.commit()
            session.refresh(p)
        return serialize(p)


@app.get("/api/projects/{project_id}/waveform")
def waveform(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    pdir = jobs.project_dir(p.id)
    try:
        return source_waveform(pdir / p.source_file, pdir / "work" / "waveforms", p.duration, p.has_audio)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Kaynak video bulunamadı.") from exc
    except SourceChangedError as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(422, f"Ses dalgası oluşturulamadı: {exc}") from exc


@app.get("/api/projects/{project_id}/transcript-edit")
def get_transcript_edit(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    return transcript_view(p.model_dump(), jobs.project_timeline(p))


def transcript_selection(p: Project, body: TranscriptSelection):
    snapshot = p.model_dump()
    if body.revision != transcript_revision(snapshot):
        raise HTTPException(409, "Kaynak, transkript veya edit değişti; transkripti yenileyip tekrar seçin.")
    timeline = jobs.project_timeline(p)
    view = transcript_view(snapshot, timeline)
    try:
        rows = selected_rows(view, body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return timeline, view, rows


@app.post("/api/projects/{project_id}/transcript-edit/cut")
def cut_transcript(project_id: str, body: TranscriptSelection, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    timeline, _, rows = transcript_selection(p, body)
    try:
        plan = cut_selection(EditPlan.model_validate(p.plan), timeline, rows)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    _set_plan(p, plan)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.post("/api/projects/{project_id}/transcript-edit/clip")
def clip_transcript(project_id: str, body: TranscriptClipBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    _, view, rows = transcript_selection(p, body)
    try:
        clip = clip_selection(view, rows)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return job_dict(jobs.submit(p.id, "transcript_clip", jobs.task_publish, p.model_dump(), body.model_dump(), [clip]))


@app.post("/api/projects/{project_id}/audio")
def upload_audio(project_id: str, file: UploadFile = File(...), session: Session = Depends(get_session)) -> dict:
    get_project(project_id, session)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in assets.AUDIO_EXT:
        raise HTTPException(400, "Desteklenmeyen ses dosyası.")
    d = jobs.project_dir(project_id) / "audio"
    d.mkdir(exist_ok=True)
    safe = "".join(c for c in Path(file.filename or "muzik").stem if c.isalnum() or c in "-_")[:60] or "muzik"
    dst = d / f"{safe}{ext}"
    with dst.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    return {"id": f"project:{dst.name}", "label": dst.stem, "url": jobs.media_url(project_id, f"audio/{dst.name}")}


@app.get("/api/projects/{project_id}/audio")
def list_project_audio(project_id: str) -> list[dict]:
    d = jobs.project_dir(project_id) / "audio"
    if not d.exists():
        return []
    return [{"id": f"project:{f.name}", "label": f.stem, "url": jobs.media_url(project_id, f"audio/{f.name}")}
            for f in sorted(d.iterdir()) if f.suffix.lower() in assets.AUDIO_EXT]


# ------------------------------------------------------------------ seslendirme (tts) ----

class VoiceoverPreviewBody(BaseModel):
    text: str
    voice: str = "tr-TR-EmelNeural"
    speed: float = 1.0


class VoiceoverApplyBody(BaseModel):
    text: str
    voice: str = "tr-TR-EmelNeural"
    speed: float = 1.0
    auto_subtitles: bool = True
    subtitle_style: str = "karaoke"


@app.post("/api/voiceover/preview")
def voiceover_preview(body: VoiceoverPreviewBody) -> dict:
    if not body.text.strip():
        raise HTTPException(400, "Metin boş olamaz.")
    tmp_name = f"preview_{uuid.uuid4().hex[:8]}.mp3"
    tmp_path = settings.storage_dir / "temp" / tmp_name
    tmp_path.parent.mkdir(parents=True, exist_ok=True)
    res = tts.generate_voiceover(body.text, voice_id=body.voice, speed=body.speed, out_path=tmp_path)
    return {
        "url": f"/media/temp/{tmp_name}",
        "duration": res["duration"],
        "words": res["words"],
        "segments": res["segments"],
    }


@app.post("/api/projects/{project_id}/voiceover")
def apply_voiceover(project_id: str, body: VoiceoverApplyBody, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    if not body.text.strip():
        raise HTTPException(400, "Metin boş olamaz.")

    pdir = jobs.project_dir(p.id)
    vo_file = "voiceover.mp3"
    vo_path = pdir / vo_file

    res = tts.generate_voiceover(body.text, voice_id=body.voice, speed=body.speed, out_path=vo_path)
    p.voiceover_file = vo_file

    transcript_data = {
        "language": res["language"],
        "segments": res["segments"],
        "words": res["words"],
        "timing_basis": "voiceover",
    }
    p.transcript = transcript_data
    p.subtitles = transcript_data
    p.subtitle_language = res["language"]

    voice_info = tts.get_voice(body.voice)
    voice_name = voice_info["name"] if voice_info else body.voice

    if body.auto_subtitles:
        plan = EditPlan.model_validate(p.plan)
        sub_op = plan.first("subtitles")
        if not sub_op:
            plan.operations.append(SubtitlesOp(style=body.subtitle_style, font_size=56, animation=True))
        else:
            sub_op.enabled = True
            if body.subtitle_style:
                sub_op.style = body.subtitle_style
        _set_plan(p, plan)

    now = datetime.now(timezone.utc).isoformat()
    clean_preview = body.text.strip()[:60]
    msg = f"🎙️ AI Seslendirme uygulandı ({voice_name}, {res['duration']}s): \"{clean_preview}{'...' if len(body.text.strip()) > 60 else ''}\". Altyazılar senkronize edildi."
    p.chat = [*p.chat, {"role": "assistant", "text": msg, "at": now, "changed": True}][-100:]

    touch(p)
    session.add(p)
    session.commit()
    session.refresh(p)
    return {"summary": msg, "project": serialize(p)}


@app.delete("/api/projects/{project_id}/voiceover")
def delete_voiceover(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.voiceover_file:
        vo_path = jobs.project_dir(p.id) / p.voiceover_file
        if vo_path.exists():
            try:
                vo_path.unlink()
            except Exception:
                pass
        p.voiceover_file = None
        now = datetime.now(timezone.utc).isoformat()
        p.chat = [*p.chat, {"role": "assistant", "text": "🎙️ AI Seslendirme kaldırıldı.", "at": now, "changed": True}][-100:]
        touch(p)
        session.add(p)
        session.commit()
        session.refresh(p)
    return {"summary": "Seslendirme kaldırıldı.", "project": serialize(p)}


# ------------------------------------------------------------------ B-Roll & Görsel Katmanları ----

class BrollGenerateBody(BaseModel):
    prompt: str


@app.get("/api/broll/library")
def get_broll_library() -> list[dict]:
    return broll.list_stock_broll()


@app.get("/api/projects/{project_id}/broll")
def list_project_broll(project_id: str) -> list[dict]:
    d = jobs.project_dir(project_id) / "broll"
    if not d.exists():
        return []
    items = []
    for f in sorted(d.iterdir()):
        if f.suffix.lower() in assets.IMAGE_EXT:
            items.append({
                "id": f"project:broll/{f.name}",
                "label": f.stem,
                "url": jobs.media_url(project_id, f"broll/{f.name}"),
            })
    return items


@app.post("/api/projects/{project_id}/broll/suggest")
def suggest_broll(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    transcript = p.subtitles or p.transcript
    suggestions = broll.suggest_broll_for_transcript(transcript, p.duration)
    return {"suggestions": suggestions}


@app.post("/api/projects/{project_id}/broll/apply-auto")
def apply_auto_broll(project_id: str, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    transcript = p.subtitles or p.transcript
    suggestions = broll.suggest_broll_for_transcript(transcript, p.duration)
    if not suggestions:
        raise HTTPException(400, "Uygun B-Roll eşleşmesi bulunamadı.")

    plan = EditPlan.model_validate(p.plan)
    for s in suggestions:
        plan.operations.append(OverlayOp.model_validate(s))
    _set_plan(p, plan)

    now = datetime.now(timezone.utc).isoformat()
    msg = f"🖼️ {len(suggestions)} adet AI B-Roll görsel katmanı otomatik olarak yerleştirildi."
    p.chat = [*p.chat, {"role": "assistant", "text": msg, "at": now, "changed": True}][-100:]

    touch(p)
    session.add(p)
    session.commit()
    session.refresh(p)
    return {"summary": msg, "count": len(suggestions), "project": serialize(p)}


@app.post("/api/projects/{project_id}/broll/generate")
def generate_broll_endpoint(project_id: str, body: BrollGenerateBody, session: Session = Depends(get_session)) -> dict:
    get_project(project_id, session)
    if not body.prompt.strip():
        raise HTTPException(400, "Prompt boş olamaz.")
    broll_dir = jobs.project_dir(project_id) / "broll"
    safe_name = f"ai_{uuid.uuid4().hex[:8]}.jpg"
    out_file = broll_dir / safe_name
    broll.generate_broll_image(body.prompt, out_file)
    return {
        "id": f"project:broll/{safe_name}",
        "label": body.prompt[:30],
        "url": jobs.media_url(project_id, f"broll/{safe_name}"),
    }


@app.post("/api/projects/{project_id}/broll/upload")
def upload_broll(project_id: str, file: UploadFile = File(...), session: Session = Depends(get_session)) -> dict:
    get_project(project_id, session)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in assets.IMAGE_EXT:
        raise HTTPException(400, f"Desteklenmeyen dosya türü: {ext}")
    broll_dir = jobs.project_dir(project_id) / "broll"
    broll_dir.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in Path(file.filename or "broll").stem if c.isalnum() or c in "-_")[:50] or "broll"
    filename = f"{safe}_{uuid.uuid4().hex[:6]}{ext}"
    dst = broll_dir / filename
    with dst.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    return {
        "id": f"project:broll/{filename}",
        "label": safe,
        "url": jobs.media_url(project_id, f"broll/{filename}"),
    }


# ------------------------------------------------------------------ render ----

@app.post("/api/projects/{project_id}/render")
def start_render(project_id: str, body: RenderOptions | None = None, session: Session = Depends(get_session)) -> dict:
    p = get_project(project_id, session)
    if p.status != "ready":
        raise HTTPException(409, "Video henüz hazır değil.")
    return job_dict(jobs.submit(p.id, "render", jobs.task_render, p.id, (body or RenderOptions()).model_dump()))


def ready_source(project_id: str, session: Session) -> Project:
    p = get_project(project_id, session)
    if p.status != "ready" or not p.source_file:
        raise HTTPException(409, "Kaynak video henüz hazır değil.")
    return p


@app.post("/api/projects/{project_id}/preview")
def start_preview(project_id: str, body: PreviewBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    try:
        preview_window(body.start, body.duration, jobs.project_timeline(p).output_duration)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return job_dict(jobs.submit(p.id, "preview", jobs.task_preview, p.model_dump(), body.model_dump()))


@app.get("/api/projects/{project_id}/download/{filename:path}")
def download_output(project_id: str, filename: str, session: Session = Depends(get_session)):
    p = get_project(project_id, session)
    root = jobs.project_dir(p.id).resolve()
    path = (root / filename).resolve()
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError:
        raise HTTPException(404, "Dosya bulunamadı.") from None
    permitted = relative.startswith("outputs/") or relative == p.thumbnail_file
    if not permitted or path.suffix.lower() not in {".mp4", ".jpg", ".zip"} or not path.is_file():
        raise HTTPException(404, "Dosya bulunamadı.")
    return FileResponse(path, filename=path.name)


@app.put("/api/projects/{project_id}/thumbnail")
def select_thumbnail(project_id: str, body: ThumbnailBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    if body.at >= p.duration:
        raise HTTPException(422, "Kapak zamanı kaynak video süresinden küçük olmalı.")
    name = f"thumb_{uuid.uuid4().hex[:12]}.jpg"
    try:
        make_thumbnail(jobs.project_dir(p.id) / p.source_file, jobs.project_dir(p.id) / name, at=body.at)
    except Exception as exc:
        raise HTTPException(422, f"Kapak karesi oluşturulamadı: {exc}") from exc
    p.thumbnail_file = name
    touch(p)
    session.add(p)
    session.commit()
    session.refresh(p)
    return serialize(p)


@app.post("/api/projects/{project_id}/export-batch")
def export_batch(project_id: str, body: BatchExportBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    if body.thumbnail_at >= p.duration:
        raise HTTPException(422, "Kapak zamanı kaynak video süresinden küçük olmalı.")
    return job_dict(jobs.submit(p.id, "export_batch", jobs.task_publish, p.model_dump(), body.model_dump()))


@app.post("/api/projects/{project_id}/clips/analyze")
def analyze_clips(project_id: str, body: ClipAnalyzeBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    if not p.has_audio:
        raise HTTPException(422, "Konuşma analizi için kaynak videoda ses olmalı.")
    if p.duration < body.min_duration:
        raise HTTPException(422, f"Kaynak video en az {body.min_duration:g} saniye olmalı.")
    return job_dict(jobs.submit(p.id, "clip_analyze", jobs.task_analyze_clips, p.model_dump(), body.model_dump()))


def _clip_candidates(p: Project, analysis_id: str, session: Session) -> dict[int, dict]:
    analysis = session.get(Job, analysis_id)
    if not analysis or analysis.project_id != p.id or analysis.kind != "clip_analyze" or analysis.status != "done":
        raise HTTPException(422, "Bu projeye ait tamamlanmış bir klip analizi seçin.")
    result = analysis.result or {}
    if result.get("source_file") != p.source_file:
        raise HTTPException(409, "Kaynak video değişti; yeniden analiz edin.")
    return {c["id"]: c for c in result.get("clips") or []}


@app.post("/api/projects/{project_id}/clips/preview")
def preview_clip(project_id: str, body: ClipPreviewBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    candidates = _clip_candidates(p, body.analysis_id, session)
    clip = candidates.get(body.clip_id)
    if clip is None:
        raise HTTPException(422, "Geçersiz klip seçimi.")
    start, end = float(clip["start"]), float(clip["end"])
    if body.clip_range is not None:
        start, end = round(body.clip_range.start, 3), round(body.clip_range.end, 3)
    if not (0 <= start < end <= p.duration and 29.99 <= end - start <= 60.01):
        raise HTTPException(422, "Klip aralıkları geçersiz; yeniden analiz edin.")
    selected = {**clip, "start": start, "end": end}
    try:
        preview_window(body.start, body.duration, end - start)
    except ValueError as exc:
        raise HTTPException(422, "Önizleme başlangıcı klibin bitişinden en az 0.1 sn önce olmalı.") from exc
    return job_dict(jobs.submit(p.id, "clip_preview", jobs.task_preview_clip, p.model_dump(), body.model_dump(), selected))


@app.post("/api/projects/{project_id}/clips/render")
def render_clips(project_id: str, body: ClipExportBody, session: Session = Depends(get_session)) -> dict:
    p = ready_source(project_id, session)
    candidates = _clip_candidates(p, body.analysis_id, session)
    if any(i not in candidates for i in body.clip_ids):
        raise HTTPException(422, "Geçersiz klip seçimi.")
    overrides = {item.id: item for item in body.clip_ranges or []}
    if body.clip_ranges is not None and set(overrides) != set(body.clip_ids):
        raise HTTPException(422, "Elle ayarlanan aralıklar seçilen kliplerle eşleşmiyor.")
    covers = {item.id: item.at for item in body.clip_covers or []}
    if body.clip_covers is not None and set(covers) != set(body.clip_ids):
        raise HTTPException(422, "Kapak zamanları seçilen kliplerle eşleşmiyor.")
    selected = []
    for clip_id in body.clip_ids:
        clip = dict(candidates[clip_id])
        if body.clip_ranges is not None:
            override = overrides[clip_id]
            clip["start"], clip["end"] = round(override.start, 3), round(override.end, 3)
        clip["cover_at"] = covers.get(clip_id, 0)
        selected.append(clip)
    if any(not (0 <= c["start"] < c["end"] <= p.duration and 29.99 <= c["end"] - c["start"] <= 60.01) for c in selected):
        raise HTTPException(422, "Klip aralıkları geçersiz; yeniden analiz edin.")
    try:
        for clip in selected:
            clip_cover_time(clip["cover_at"], clip["end"] - clip["start"])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return job_dict(jobs.submit(p.id, "clip_render", jobs.task_publish, p.model_dump(), body.model_dump(), selected))
