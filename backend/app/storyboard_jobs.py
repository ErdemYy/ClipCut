"""Checkpointed multi-scene generation, narration and deterministic FFmpeg assembly."""
from __future__ import annotations

import copy
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import jobs
from .ai import services as ai, tts
from .config import get_settings
from .edit.schema import EditPlan, SubtitlesOp
from .ffmpeg import probe, run_ffmpeg_with_progress
from .models import Project
from .storyboard import fingerprint, scene_file, scene_ready, transition_overlap, trim_range, trim_transcript_segments, visual_fingerprint


def normalize_scene(raw: Path, output: Path, requested_duration: float, aspect: str,
                    narration: Path | None, narration_duration: float, progress) -> float:
    info = probe(raw)
    if not info.has_video:
        raise ValueError("Üretilen sahnede video akışı yok.")
    duration = max(requested_duration, narration_duration + 0.15 if narration else 0)
    if duration > 30:
        raise ValueError("Sahne anlatımı çok uzun; metni kısaltın.")
    width, height = (720, 1280) if aspect == "9:16" else (1280, 720)
    inputs = ["-i", str(raw)]
    if narration:
        inputs += ["-i", str(narration)]
        audio = "1:a"
    elif info.has_audio:
        audio = "0:a"
    else:
        inputs += ["-f", "lavfi", "-t", str(duration), "-i", "anullsrc=r=48000:cl=stereo"]
        audio = "1:a"
    filters = (
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,"
        f"tpad=stop_mode=clone:stop_duration={duration:.3f},trim=duration={duration:.3f},setpts=PTS-STARTPTS[v];"
        f"[{audio}]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={duration:.3f},asetpts=PTS-STARTPTS[a]"
    )
    run_ffmpeg_with_progress([
        *inputs, "-filter_complex", filters, "-map", "[v]", "-map", "[a]", "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output),
    ], duration, progress)
    return probe(output).duration


def assemble_scenes(files: list[Path], output: Path, work: Path, progress,
                    ranges: list[tuple[float, float]] | None = None,
                    scenes: list[dict] | None = None) -> list[float]:
    """Trim, apply cut/dissolve/fade transitions and return each scene's start time."""
    work.mkdir(parents=True, exist_ok=True)
    if ranges is not None and len(ranges) != len(files):
        raise ValueError("Sahne ve kırpma sayıları eşleşmiyor.")
    if scenes is not None and len(scenes) != len(files):
        raise ValueError("Sahne ve geçiş sayıları eşleşmiyor.")
    transitions = scenes or [{} for _ in files]
    prepared = []
    durations = []
    for i, path in enumerate(files):
        duration = probe(path).duration
        start, end = ranges[i] if ranges is not None else (0, duration)
        # Validate again against the actual file, not client-reported metadata.
        start, end = trim_range({"duration": duration, "trim_start": start, "trim_end": end}, duration)
        if start > 1e-6 or end < duration - 1e-6:
            trimmed = work / f"trimmed_{i:02d}.mp4"
            run_ffmpeg_with_progress([
                "-i", str(path), "-vf", f"trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS",
                "-af", f"atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS", "-t", f"{end - start:.6f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(trimmed),
            ], end - start, lambda v: progress((i + v) / (len(files) + 1)))
            path = trimmed
        prepared.append(path)
        durations.append(probe(path).duration)
    overlaps = [0.0]
    starts = [0.0]
    for i in range(1, len(files)):
        overlaps.append(transition_overlap(durations[i - 1], durations[i], transitions[i]))
        starts.append(round(starts[-1] + durations[i - 1] - overlaps[-1], 6))
    expected = round(starts[-1] + durations[-1], 6)
    combine = lambda v: progress((len(files) + v) / (len(files) + 1))
    if not any(overlaps):
        # Fast path: no overlaps, stream-copy concatenation.
        manifest = work / "concat.txt"
        paths = [os.path.relpath(path, work).replace("\\", "/") for path in prepared]
        if any("'" in path or "\n" in path or "\r" in path for path in paths):
            raise ValueError("Birleştirme dosya yolu geçersiz.")
        manifest.write_text("\n".join(f"file '{path}'" for path in paths), encoding="utf-8")
        run_ffmpeg_with_progress([
            "-f", "concat", "-safe", "0", "-i", str(manifest), "-c", "copy", "-movflags", "+faststart", str(output),
        ], expected, combine, cwd=work)
    else:
        # One filter graph keeps video and audio transitions in sync; caption offsets use the same starts.
        parts, v, a = [], "0:v", "0:a"
        for i in range(1, len(files)):
            if overlaps[i] <= 0:
                parts.append(f"[{v}][{i}:v]concat=n=2:v=1:a=0[v{i}]")
                parts.append(f"[{a}][{i}:a]concat=n=2:v=0:a=1[a{i}]")
            else:
                offset = round(starts[i - 1] + durations[i - 1] - overlaps[i], 6)
                name = "fadeblack" if transitions[i].get("transition") == "fade" else "fade"
                parts.append(f"[{v}][{i}:v]xfade=transition={name}:duration={overlaps[i]:.3f}:offset={offset:.3f}[v{i}]")
                parts.append(f"[{a}][{i}:a]acrossfade=d={overlaps[i]:.3f}:c1=tri:c2=tri[a{i}]")
            v, a = f"v{i}", f"a{i}"
        args = []
        for path in prepared:
            args += ["-i", str(path)]
        args += ["-filter_complex", ";".join(parts), "-map", f"[{v}]", "-map", f"[{a}]",
                 "-t", f"{expected:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                 "-movflags", "+faststart", str(output)]
        run_ffmpeg_with_progress(args, expected, combine)
    info = probe(output)
    if not info.has_video or not info.has_audio or abs(info.duration - expected) > max(0.6, len(files) * 0.1):
        raise ValueError("Birleştirilen videonun süresi veya ses akışı doğrulanamadı.")
    return starts


def _checkpoint(project_id: str, scene_id: str, values: dict) -> None:
    def update(p: Project):
        spec = copy.deepcopy(p.storyboard)
        scene = next(s for s in spec["scenes"] if s["id"] == scene_id)
        scene.update(values)
        p.storyboard = spec
    jobs._save_project(project_id, update)


def task_generate_storyboard(progress, project_id: str, scene_id: str | None = None,
                             cancel: threading.Event | None = None) -> dict:
    p = jobs._load(project_id)
    spec = copy.deepcopy(p.storyboard)
    pdir = jobs.project_dir(p.id)
    settings = get_settings()
    target = [s for s in spec["scenes"] if scene_id == s["id"]] if scene_id else [s for s in spec["scenes"] if not scene_ready(p.id, spec, s)]
    current_scene = None
    try:
        for index, scene in enumerate(target):
            # Co-operative stop: finished scenes stay usable, the running scene completes first.
            if cancel is not None and cancel.is_set():
                progress(0.97, "Durduruluyor; hazır sahneler korunuyor")
                break
            current_scene = scene["id"]
            key = fingerprint(spec, scene)
            # Never overwrite a previously published scene, even on an explicit re-generation.
            folder = pdir / "storyboard" / "scenes" / scene["id"] / uuid.uuid4().hex[:12]
            folder.mkdir(parents=True, exist_ok=True)
            visual_key = visual_fingerprint(spec, scene)
            raw = scene_file(p.id, scene.get("raw_file")) if scene.get("raw_fingerprint") == visual_key and not scene_id else None
            _checkpoint(p.id, scene["id"], {"status": "generating", "error": None})
            progress(index / max(1, len(target)) * 0.85, f"Sahne {index + 1}/{len(target)} · ses ve video hazırlanıyor")
            narration, transcript = None, None
            spoken_duration = 0.0
            if spec["voiceover"]:
                narration = folder / "narration.mp3"
                result = tts.generate_voiceover(scene["narration"], voice_id=spec["voice_id"], out_path=narration,
                                                mock_mode=settings.is_mock, allow_fallback=False)
                spoken_duration = result["duration"]
                if spoken_duration > 29:
                    raise ValueError("Sahne anlatımı çok uzun; metni kısaltın. Video API çağrısı yapılmadı.")
                transcript = {"language": spec["language"], "segments": result["segments"], "mock": result.get("mock", False)}
            if raw is None:
                raw = folder / "raw.mp4"
                prompt = f"{scene['visual_prompt']}\nVisual style: {spec['style']}\nContinuity: {spec.get('continuity', '')}"
                if spec["voiceover"]:
                    prompt += "\nNo dialogue, no on-screen text. Narration will be added separately."
                kwargs = {"model": spec["video_model"]} if spec.get("video_model") else {}
                ai.generate_video(prompt, spec["aspect_ratio"], scene["duration"], None, raw,
                                  lambda v, m: progress((index + v * 0.7) / max(1, len(target)) * 0.85, f"{scene['title']} · {m}"),
                                  **kwargs)
                if not probe(raw).has_video:
                    raise ValueError("Video üretimi geçerli bir video dosyası döndürmedi.")
                _checkpoint(p.id, scene["id"], {"raw_file": raw.relative_to(pdir).as_posix(), "raw_fingerprint": visual_key, "fingerprint": key})
            output = folder / "scene.mp4"
            duration = normalize_scene(raw, output, scene["duration"], spec["aspect_ratio"], narration, spoken_duration,
                                        lambda v: progress((index + 0.7 + v * 0.3) / max(1, len(target)) * 0.85, f"{scene['title']} · sahne işleniyor"))
            try:
                trim_range(scene, duration)
            except ValueError as exc:
                raise ValueError("Yeni sahne mevcut kırpma aralığından kısa; kırpmayı sıfırlayıp devam edin. Ham video korunmuştur.") from exc
            _checkpoint(p.id, scene["id"], {
                "status": "ready", "file": output.relative_to(pdir).as_posix(), "fingerprint": key,
                "actual_duration": duration, "transcript": transcript, "mock": settings.is_mock, "error": None,
            })
        current_scene = None
        progress(0.86, "Sahneler kontrol ediliyor")
        spec = jobs._load(project_id).storyboard
        remaining = sum(1 for s in spec["scenes"] if not scene_ready(p.id, spec, s))
        if remaining:
            jobs._save_project(p.id, lambda proj: setattr(proj, "status", "ready" if proj.source_file else "draft"))
            if cancel is not None and cancel.is_set():
                # Stopping intentionally leaves media unassembled; resuming regenerates only the leftovers.
                return {"assembled": False, "stopped": True, "remaining": remaining,
                        "message": f"Üretim durduruldu. Hazır sahneler korunuyor; kalan {remaining} sahne için tekrar başlatabilirsiniz."}
            return {"assembled": False, "message": "Seçilen sahne hazır. Kalan sahneleri üretip birleştirebilirsiniz."}
        run_id = uuid.uuid4().hex[:12]
        root = pdir / "storyboard" / "assemblies" / run_id
        root.mkdir(parents=True)
        source = root / "source.mp4"
        progress(0.87, "Sahneler birleştiriliyor")
        ranges = [trim_range(scene) for scene in spec["scenes"]]
        starts = assemble_scenes([scene_file(p.id, s["file"]) for s in spec["scenes"]], source, root,
                                 lambda v: progress(0.87 + v * 0.1, "Sahneler birleştiriliyor"), ranges, spec["scenes"])
        segments = []
        for scene, (start, end), offset in zip(spec["scenes"], ranges, starts):
            for seg in trim_transcript_segments(scene.get("transcript"), start, end, offset):
                segments.append({**seg, "id": len(segments)})
        transcript = {"language": spec["language"], "segments": segments, "mock": settings.is_mock} if spec["voiceover"] else None

        def finish(proj: Project):
            updated = copy.deepcopy(proj.storyboard)
            # The spec that produced the CURRENT source is archived with it, so a
            # restored version is guaranteed to match its own media.
            previous_spec = updated.pop("source_spec", None)
            if proj.source_file:
                # Keep media AND editor state; never destroy prior work on assembly.
                previous = {"created_at": datetime.now(timezone.utc).isoformat(), "source_file": proj.source_file,
                            "plan": proj.plan, "plan_history": proj.plan_history, "transcript": proj.transcript,
                            "subtitles": proj.subtitles, "subtitle_language": proj.subtitle_language,
                            "output_file": proj.output_file, "output_meta": proj.output_meta,
                            "thumbnail_file": proj.thumbnail_file, "voiceover_file": proj.voiceover_file,
                            "spec": copy.deepcopy(previous_spec) if isinstance(previous_spec, dict) else None}
                # Times are rolling: only the newest assemblies stay listed (files stay on disk).
                updated["previous_versions"] = [*updated.get("previous_versions", []), previous][-6:]
            jobs.ingest_source(proj, source, thumbnail_name=f"thumb_{run_id}.jpg")
            proj.voiceover_file = None  # Narration is embedded in the new source audio.
            proj.transcript = transcript
            proj.subtitles = transcript
            proj.subtitle_language = spec["language"] if transcript else None
            proj.plan = EditPlan(operations=[SubtitlesOp()] if transcript and spec["auto_subtitles"] else []).model_dump()
            proj.plan_history = []
            proj.output_file = None
            proj.output_meta = None
            updated["assembled_revision"] = updated["revision"]
            updated["last_error"] = None
            updated.pop("source_spec", None)
            updated["source_spec"] = copy.deepcopy(updated)  # This media belongs to this exact spec.
            proj.storyboard = updated

        jobs._save_project(p.id, finish)
        return {"assembled": True, "source": jobs.media_url(p.id, source.relative_to(pdir).as_posix()),
                "scenes": len(spec["scenes"]), "duration": probe(source).duration, "mock": settings.is_mock}
    except Exception as exc:
        if current_scene:
            _checkpoint(p.id, current_scene, {"status": "failed", "error": str(exc)[:2000]})
        def failed(proj: Project):
            spec = copy.deepcopy(proj.storyboard)
            spec["last_error"] = str(exc)[:2000]
            proj.storyboard = spec
            proj.status = "ready" if proj.source_file else "failed"
        jobs._save_project(p.id, failed)
        raise
