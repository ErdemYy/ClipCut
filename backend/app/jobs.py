"""Arka plan işleri: video üretimi, transkripsiyon, çeviri ve render."""
from __future__ import annotations

import json
import hashlib
import logging
import threading
import traceback
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from sqlmodel import Session, select

from . import assets
from .ai import services as ai
from .config import get_settings
from .edit.renderer import RenderRequest, render
from .edit.schema import EditPlan
from .edit.timeline import Timeline, build_timeline
from .ffmpeg import MediaInfo, detect_silences, extract_audio, make_thumbnail, probe
from .models import Job, Project, engine

log = logging.getLogger("clipcut.jobs")
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="clipcut-job")
# Cooperative cancellation: only workers that check the event can be stopped.
_cancels: dict[str, threading.Event] = {}
_cancel_lock = threading.Lock()
# Serializes the active-job check + insert in submit so a double submit cannot slip through.
_submit_lock = threading.Lock()


class DuplicateJobError(RuntimeError):
    """Raised when the same job kind is already queued or running for the project."""


def project_dir(project_id: str) -> Path:
    d = get_settings().storage_dir / "projects" / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def media_url(project_id: str, rel: str | None) -> str | None:
    return f"/media/projects/{project_id}/{rel}" if rel else None


def media_info(p: Project) -> MediaInfo:
    return MediaInfo(duration=p.duration, width=p.width, height=p.height, fps=30.0, has_audio=p.has_audio, has_video=True)


def ingest_source(p: Project, path: Path, *, thumbnail_name: str = "thumb.jpg") -> None:
    info = probe(path)
    if not info.has_video:
        raise ValueError("Dosyada video akışı bulunamadı.")
    pdir = project_dir(p.id)
    thumb = pdir / thumbnail_name
    try:
        make_thumbnail(path, thumb, at=min(1.0, info.duration / 3))
        p.thumbnail_file = thumbnail_name
    except Exception:
        log.warning("Küçük resim oluşturulamadı", exc_info=True)
    p.source_file = path.relative_to(pdir).as_posix()
    p.duration, p.width, p.height, p.has_audio = info.duration, info.width, info.height, info.has_audio
    p.status = "ready"


def silence_provider(p: Project) -> Callable[[float, float], list[tuple[float, float]]]:
    def provider(threshold_db: float, min_s: float) -> list[tuple[float, float]]:
        if not p.has_audio or not p.source_file:
            return []
        cache = project_dir(p.id) / f"silence_{threshold_db:g}_{min_s:g}.json"
        if cache.exists():
            return [tuple(x) for x in json.loads(cache.read_text())]
        result = detect_silences(project_dir(p.id) / p.source_file, threshold_db, min_s, p.duration)
        cache.write_text(json.dumps(result))
        return result

    return provider


def project_timeline(p: Project, plan: EditPlan | None = None) -> Timeline:
    plan = plan or EditPlan.model_validate(p.plan)
    return build_timeline(plan, p.duration, silence_provider(p))


# ------------------------------------------------------------------ altyapı ----

def submit(project_id: str, kind: str, fn: Callable[..., dict | None], *args, cancellable: bool = False) -> Job:
    # One active job per project and kind: double submissions would duplicate paid provider
    # calls (generate/transcribe/translate) or waste long local runs (render/export).
    with _submit_lock:
        with Session(engine) as s:
            active = s.exec(select(Job).where(
                Job.project_id == project_id, Job.kind == kind,
                Job.status.in_(("queued", "running")))).first()  # type: ignore[attr-defined]
            if active is not None:
                raise DuplicateJobError(
                    f"Bu proje için '{kind}' işlemi zaten sırada veya sürüyor; bitmesini bekleyin.")
            cancel_event = threading.Event() if cancellable else None
            job = Job(project_id=project_id, kind=kind, message="Sırada")
            s.add(job)
            s.commit()
            s.refresh(job)
            job_id = job.id
            if cancel_event is not None:
                with _cancel_lock:
                    _cancels[job_id] = cancel_event
    # The event is appended as the last positional argument for cancellable tasks.
    _executor.submit(_run, job_id, fn, cancel_event, *args)
    with Session(engine) as s:
        return s.get(Job, job_id)


def cancel(job_id: str) -> bool:
    """Request a stop; returns False for unknown, finished or non-cancellable jobs."""
    with Session(engine) as s:
        job = s.get(Job, job_id)
        if not job or job.status not in ("queued", "running"):
            return False
        with _cancel_lock:
            event = _cancels.get(job_id)
        if not event:
            return False
        event.set()
        job.message = "Durdurma istendi; sürmekte olan adım bitirilir"
        s.add(job)
        s.commit()
        return True


def _update(job_id: str, **fields) -> None:
    with Session(engine) as s:
        job = s.get(Job, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        s.add(job)
        s.commit()


def _run(job_id: str, fn: Callable[..., dict | None], cancel_event: threading.Event | None, *args) -> None:
    _update(job_id, status="running", message="Başladı", progress=0.01)

    def progress(value: float, message: str | None = None) -> None:
        fields = {"progress": round(max(0.0, min(1.0, value)), 3)}
        if message:
            fields["message"] = message
        _update(job_id, **fields)

    try:
        if cancel_event is None:
            result = fn(progress, *args)
        else:
            result = fn(progress, *args, cancel_event)
        _update(job_id, status="done", progress=1.0, message="Tamamlandı", result=result,
                finished_at=datetime.now(timezone.utc))
    except Exception as exc:
        log.error("İş başarısız: %s\n%s", job_id, traceback.format_exc())
        _update(job_id, status="failed", error=str(exc)[:4000], message="Hata", finished_at=datetime.now(timezone.utc))
    finally:
        with _cancel_lock:
            _cancels.pop(job_id, None)


def _save_project(project_id: str, mutate: Callable[[Project], None]) -> None:
    with Session(engine) as s:
        p = s.get(Project, project_id)
        if not p:
            raise ValueError("Proje bulunamadı")
        mutate(p)
        p.updated_at = datetime.now(timezone.utc)
        s.add(p)
        s.commit()


def _load(project_id: str) -> Project:
    with Session(engine) as s:
        p = s.get(Project, project_id)
        if not p:
            raise ValueError("Proje bulunamadı")
        s.expunge(p)
        return p


# ------------------------------------------------------------------ işler ----

def task_generate(progress, project_id: str, prompt: str, aspect: str, duration: int, negative: str | None,
                  model: str | None = None) -> dict:
    pdir = project_dir(project_id)
    out = pdir / "source.mp4"
    try:
        if model:
            ai.generate_video(prompt, aspect, duration, negative, out, lambda v, m: progress(v, m), model=model)
        else:
            ai.generate_video(prompt, aspect, duration, negative, out, lambda v, m: progress(v, m))
        progress(0.97, "Video analiz ediliyor")
        _save_project(project_id, lambda p: ingest_source(p, out))
    except Exception:
        _save_project(project_id, lambda p: setattr(p, "status", "failed"))
        raise
    return {"source": "source.mp4"}


def task_transcribe(progress, project_id: str, target_language: str | None) -> dict:
    p = _load(project_id)
    if not p.source_file:
        raise ValueError("Projede video yok.")
    pdir = project_dir(project_id)
    if p.has_audio:
        progress(0.1, "Ses ayrıştırılıyor")
        audio = pdir / "audio_16k.mp3"
        extract_audio(pdir / p.source_file, audio)
        progress(0.25, "Konuşma yazıya dökülüyor (Gemini)")
        transcript = ai.transcribe(audio, p.duration)
    else:
        transcript = ai.mock.transcript(p.duration) if get_settings().is_mock else {"language": "und", "segments": []}
    transcript = {**transcript, "timing_basis": "source"}
    subtitles = transcript
    target = target_language or transcript.get("language")
    if target_language and target_language != transcript.get("language"):
        progress(0.7, f"Çevriliyor → {target_language}")
        subtitles = ai.translate(transcript, target_language)

    def mutate(proj: Project) -> None:
        proj.transcript = transcript
        proj.subtitles = subtitles
        proj.subtitle_language = target
        plan = EditPlan.model_validate(proj.plan)
        if not plan.first("subtitles"):
            from .edit.schema import SubtitlesOp

            proj.plan_history = [*proj.plan_history, proj.plan][-50:]
            proj.plan = EditPlan(operations=[*plan.operations, SubtitlesOp()]).model_dump()

    _save_project(project_id, mutate)
    return {"language": transcript.get("language"), "segments": len(transcript.get("segments", [])), "subtitle_language": target}


def task_translate(progress, project_id: str, target: str) -> dict:
    p = _load(project_id)
    if not p.transcript:
        raise ValueError("Önce transkripsiyon yapılmalı.")
    progress(0.2, f"Çevriliyor → {target}")
    subtitles = p.transcript if target == p.transcript.get("language") else ai.translate(p.transcript, target)

    def mutate(proj: Project) -> None:
        proj.subtitles = subtitles
        proj.subtitle_language = target

    _save_project(project_id, mutate)
    return {"subtitle_language": target}


def task_render(progress, project_id: str, options: dict | None = None) -> dict:
    p = _load(project_id)
    if not p.source_file:
        raise ValueError("Projede video yok.")
    pdir = project_dir(project_id)
    plan = EditPlan.model_validate(p.plan)
    progress(0.03, "Zaman çizelgesi hesaplanıyor")
    timeline = project_timeline(p, plan)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:8]
    out_rel = f"outputs/clipcut_{stamp}.mp4"
    voiceover_path = (pdir / p.voiceover_file) if p.voiceover_file and (pdir / p.voiceover_file).exists() else None
    req = RenderRequest(
        source=pdir / p.source_file, info=media_info(p), plan=plan, timeline=timeline,
        transcript=p.subtitles, work_dir=pdir / "work" / stamp, output=pdir / out_rel,
        fonts_dir=assets.fonts_dir(), resolve_track=lambda t: assets.resolve_track(t, pdir),
        voiceover=voiceover_path,
        resolve_overlay=lambda t: assets.resolve_overlay(t, pdir),
        **(options or {}),
    )
    progress(0.06, "Render ediliyor")
    meta = render(req, lambda v: progress(0.06 + v * 0.92, "Render ediliyor"))
    meta["timeline"] = timeline.to_dict()
    meta["rendered_at"] = datetime.now(timezone.utc).isoformat()

    def mutate(proj: Project) -> None:
        proj.output_file = out_rel
        proj.output_meta = meta

    _save_project(project_id, mutate)
    return {"output": media_url(project_id, out_rel), **meta}


def render_revision(p: Project) -> str:
    """Only render inputs: renaming, cover selection or full renders don't stale a preview."""
    state = {key: getattr(p, key) for key in (
        "source_file", "duration", "width", "height", "has_audio", "voiceover_file", "plan", "subtitles",
    )}
    state["duration"] = float(p.duration)
    return hashlib.sha256(json.dumps(state, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def task_preview(progress, snapshot: dict, options: dict) -> dict:
    from .publishing import PreviewBody, preview_window

    p = Project.model_validate(snapshot)
    opts = PreviewBody.model_validate(options)
    if not p.source_file:
        raise ValueError("Projede video yok.")
    progress(0.03, "Önizleme zaman çizelgesi hesaplanıyor")
    plan = EditPlan.model_validate(p.plan)
    timeline = project_timeline(p, plan)
    duration = preview_window(opts.start, opts.duration, timeline.output_duration)
    pdir = project_dir(p.id)
    token = uuid.uuid4().hex
    out_rel = f"outputs/previews/{token}.mp4"
    req = RenderRequest(
        source=pdir / p.source_file, info=media_info(p), plan=plan, timeline=timeline,
        transcript=p.subtitles, work_dir=pdir / "work" / "previews" / token, output=pdir / out_rel,
        fonts_dir=assets.fonts_dir(), resolve_track=lambda t: assets.resolve_track(t, pdir),
        resolve_overlay=lambda t: assets.resolve_overlay(t, pdir),
        voiceover=pdir / p.voiceover_file if p.voiceover_file else None,
        resolution=opts.resolution, quality=opts.quality,
        output_start=opts.start, output_duration=duration,
    )
    progress(0.06, "Kısa önizleme işleniyor; seçilen aralığa hazırlanılıyor")
    try:
        meta = render(req, lambda v: progress(0.06 + v * 0.92, "Kısa önizleme render ediliyor"))
        info = probe(req.output)
        if not info.has_video or not info.has_audio or abs(info.duration - duration) > 0.2:
            raise ValueError("Önizleme çıktısının süresi veya medya akışları doğrulanamadı.")
    except Exception:
        req.output.unlink(missing_ok=True)
        raise
    # Never save a Project: output_file, edit history and full-render metadata stay untouched.
    return {"output": media_url(p.id, out_rel), **meta, "start": opts.start,
            "end": opts.start + duration, "resolution": opts.resolution, "quality": opts.quality,
            "render_revision": render_revision(p)}


def task_preview_clip(progress, snapshot: dict, options: dict, clip: dict) -> dict:
    """Render a clip-relative window with the same full-clip styling as export."""
    from .publishing import ClipPreviewBody, clip_plan, preview_window

    p = Project.model_validate(snapshot)
    opts = ClipPreviewBody.model_validate(options)
    if not p.source_file:
        raise ValueError("Projede video yok.")
    start, end = float(clip["start"]), float(clip["end"])
    if not (0 <= start < end <= p.duration):
        raise ValueError("Klip önizleme aralığı geçersiz.")
    preview_duration = preview_window(opts.start, opts.duration, end - start)
    pdir = project_dir(p.id)
    base = EditPlan.model_validate(p.plan)
    plan = clip_plan(base, start, end, opts.aspect_ratio, opts.fill)
    timeline = project_timeline(p, plan)
    token = uuid.uuid4().hex
    out_rel = f"outputs/clip_previews/{token}.mp4"
    progress(0.05, "Klip önizlemesi hazırlanıyor")
    req = RenderRequest(
        source=pdir / p.source_file, info=media_info(p), plan=plan, timeline=timeline,
        # Match task_publish: a generated voiceover is never mixed into source clips.
        transcript=p.subtitles if not p.voiceover_file else None,
        work_dir=pdir / "work" / "clip_previews" / token, output=pdir / out_rel,
        fonts_dir=assets.fonts_dir(), resolve_track=lambda t: assets.resolve_track(t, pdir),
        resolve_overlay=lambda t: assets.resolve_overlay(t, pdir), voiceover=None,
        resolution=opts.resolution, quality=opts.quality,
        output_start=opts.start, output_duration=preview_duration,
    )
    try:
        meta = render(req, lambda value: progress(0.05 + value * 0.94, "Gerçek klip önizlemesi render ediliyor"))
        info = probe(req.output)
        if not info.has_video or abs(info.duration - preview_duration) > 0.25:
            raise ValueError("Klip önizlemesinin süresi veya video akışı doğrulanamadı.")
    except Exception:
        req.output.unlink(missing_ok=True)
        raise
    # Preview output only; project plan, source, render metadata and full clips stay untouched.
    return {"output": media_url(p.id, out_rel), **meta, "duration": preview_duration,
             "start": start + opts.start, "end": start + opts.start + preview_duration,
             "preview_start": opts.start, "requested_duration": opts.duration,
            "clip_id": clip.get("id"), "clip_start": start, "clip_end": end,
            "analysis_id": opts.analysis_id, "aspect_ratio": opts.aspect_ratio,
            "fill": opts.fill, "resolution": opts.resolution, "quality": opts.quality,
            "render_revision": render_revision(p)}


def task_analyze_clips(progress, snapshot: dict, options: dict) -> dict:
    from .publishing import ClipAnalyzeBody, rank_clips, sentence_boundaries

    p = Project.model_validate(snapshot)
    opts = ClipAnalyzeBody.model_validate(options)
    progress(0.1, "Kaynak sesteki sessizlikler analiz ediliyor")
    silences = silence_provider(p)(opts.threshold_db, opts.min_silence_ms / 1000)
    progress(0.75, "Konuşma yoğunluğu ve transkript ipuçlarına göre klip adayları sıralanıyor")
    # A generated voiceover does not describe the source audio being analyzed.
    transcript = p.transcript if not p.voiceover_file else None
    clips = rank_clips(p.duration, silences, opts, transcript)
    return {"clips": clips, "method": "local_speech_activity", "scoring": "smart_local_v1",
            "transcript_used": any(clip.get("transcript_used") for clip in clips),
            "sentence_boundaries": sentence_boundaries(p.duration, transcript),
            "source_file": p.source_file,
            "notice": ("Yerel sessizlik/konuşma analizi; gerçek kaynak transkripti varsa cümle sınırları, "
                       "açılış kancası ve konu terimleri de puanlanır. Viral başarı, anlamsal önem veya "
                       "ücretli AI yargısı garantisi değildir."),
            "empty_reason": None if clips else "Yeterli konuşma içeren 30–60 saniyelik bir aralık bulunamadı."}


def task_publish(progress, snapshot: dict, options: dict, clips: list[dict] | None = None) -> dict:
    """Sequential batch with immutable editor snapshot and unique, job-local files."""
    from .publishing import FORMAT_NAMES, clip_plan, export_plan

    p = Project.model_validate(snapshot)
    pdir = project_dir(p.id)
    token = uuid.uuid4().hex
    out_dir = pdir / "outputs" / token
    out_dir.mkdir(parents=True)
    base = EditPlan.model_validate(p.plan)
    entries = clips if clips is not None else [{"aspect_ratio": f} for f in options["formats"]]
    outputs = []
    for i, entry in enumerate(entries):
        aspect = options["aspect_ratio"] if clips is not None else entry["aspect_ratio"]
        plan = (clip_plan(base, entry["start"], entry["end"], aspect, options["fill"])
                if clips is not None else export_plan(base, aspect, options["fill"]))
        tl = project_timeline(p, plan)
        stem = f"clip_{i + 1:02d}_{FORMAT_NAMES[aspect]}" if clips is not None else FORMAT_NAMES[aspect]
        output = out_dir / f"{stem}.mp4"
        vo = pdir / p.voiceover_file if clips is None and p.voiceover_file else None
        req = RenderRequest(
            source=pdir / p.source_file, info=media_info(p), plan=plan, timeline=tl,
            transcript=p.subtitles if clips is None or not p.voiceover_file else None,
            work_dir=pdir / "work" / token / stem, output=output,
            fonts_dir=assets.fonts_dir(), resolve_track=lambda t: assets.resolve_track(t, pdir),
            resolve_overlay=lambda t: assets.resolve_overlay(t, pdir), voiceover=vo,
            resolution=options["resolution"], quality=options["quality"],
        )
        progress(i / len(entries), f"{i + 1}/{len(entries)} · {aspect} render ediliyor")
        meta = render(req, lambda value: progress((i + value * 0.95) / len(entries), f"{i + 1}/{len(entries)} · {aspect}"))
        # Selected frame is in SOURCE time. Map it to each edited output;
        # if it was cut away, explicitly fall back to that output's first frame.
        mapped = tl.map_time(options.get("thumbnail_at", entry.get("start", 0)))
        at = min(max(0, mapped or 0), max(0, tl.output_duration - 0.1))
        thumb = out_dir / f"{stem}.jpg"
        make_thumbnail(output, thumb, at=at)
        outputs.append({"aspect_ratio": aspect, "label": stem, **meta,
                        "start": entry.get("start"), "end": entry.get("end"),
                        "output": media_url(p.id, output.relative_to(pdir).as_posix()),
                        "thumbnail": media_url(p.id, thumb.relative_to(pdir).as_posix()),
                        "thumbnail_fallback": mapped is None})
    archive = out_dir / "clipcut_exports.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zf:
        for file in sorted(out_dir.iterdir()):
            if file.suffix in {".mp4", ".jpg"}:
                zf.write(file, file.name)
    return {"outputs": outputs, "archive": media_url(p.id, archive.relative_to(pdir).as_posix()),
            "rendered_at": datetime.now(timezone.utc).isoformat()}
