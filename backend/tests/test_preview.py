"""Short output-time renders: API isolation, immutable snapshots and real FFmpeg parity."""
from __future__ import annotations

import copy
from array import array
from dataclasses import replace

import pytest
from pydantic import ValidationError

from app.edit.renderer import RenderRequest, build_command, render
from app.edit.schema import EditPlan
from app.edit.timeline import build_timeline
from app.ffmpeg import MediaInfo, probe, run_ffmpeg
from app.publishing import PreviewBody, preview_window
from .test_publishing import isolated_api  # noqa: F401 - shared isolated DB/API fixture


@pytest.mark.parametrize("body", [
    {"start": -1}, {"start": float("inf")}, {"start": float("nan")},
    {"duration": 0}, {"duration": 11}, {"resolution": "8k"}, {"quality": "ultra"},
])
def test_preview_validation(body):
    with pytest.raises(ValidationError):
        PreviewBody.model_validate(body)


def test_preview_bounds_and_short_tail():
    assert preview_window(2, 5, 20) == 5
    assert preview_window(2, 10, 4) == 2
    assert preview_window(0, 5, 0.8) == 0.8
    for start, duration, total in [(20, 5, 20), (19.95, 5, 20), (0, 5, 0), (0, float("nan"), 20)]:
        with pytest.raises(ValueError):
            preview_window(start, duration, total)


def test_preview_api_uses_edited_time_and_snapshot(isolated_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, captures = isolated_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.plan = {"operations": [{"type": "trim", "start": 20, "end": 40}, {"type": "speed", "factor": 2}]}
        p.output_file = "outputs/existing.mp4"
        session.add(p)
        session.commit()
    response = client.post("/api/projects/video/preview", json={"start": 8, "duration": 5, "quality": "high"})
    assert response.status_code == 200
    kind, args = captures[-1]
    assert kind == "preview" and args[0]["output_file"] == "outputs/existing.mp4"
    assert args[1]["start"] == 8 and args[1]["quality"] == "high"
    assert client.post("/api/projects/video/preview", json={"start": 10}).status_code == 422
    assert client.post("/api/projects/video/preview", json={"start": 9.95}).status_code == 422
    assert client.post("/api/projects/video/preview", json={"duration": 20}).status_code == 422
    assert client.post("/api/projects/missing/preview", json={}).status_code == 404
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.status = "generating"
        session.add(p)
        session.commit()
    assert client.post("/api/projects/video/preview", json={}).status_code == 409


def test_preview_revision_tracks_only_render_inputs():
    from app.jobs import render_revision
    from app.models import Project

    p = Project(name="Test", source_file="source.mp4", duration=10)
    revision = render_revision(p)
    assert render_revision(Project.model_validate(p.model_dump())) == revision
    p.name = "Renamed"
    p.output_file = "outputs/full.mp4"
    p.thumbnail_file = "cover.jpg"
    assert render_revision(p) == revision
    for field, value in [("plan", {"operations": [{"type": "speed", "factor": 2}]}),
                         ("source_file", "new.mp4"), ("voiceover_file", "vo.wav"),
                         ("subtitles", {"segments": []})]:
        changed = p.model_copy(deep=True)
        setattr(changed, field, value)
        assert render_revision(changed) != revision


def test_preview_command_keeps_full_filter_graph(tmp_path):
    plan = EditPlan.model_validate({"operations": [
        {"type": "cut_range", "start": 2, "end": 3}, {"type": "speed", "factor": 1.25},
        {"type": "transition", "duration": 0.4}, {"type": "fade", "fade_in": 1, "fade_out": 1},
        {"type": "text", "text": "Title", "start": 4, "duration": 2},
    ]})
    req = RenderRequest(source=tmp_path / "source.mp4", info=MediaInfo(12, 160, 90, 30, True, True),
                        plan=plan, timeline=build_timeline(plan, 12), transcript=None, work_dir=tmp_path,
                        output=tmp_path / "out.mp4", fonts_dir=tmp_path, resolve_track=lambda _: None)
    full, total = build_command(req)
    short, short_total = build_command(replace(req, output_start=3, output_duration=5))
    assert full[full.index("-filter_complex") + 1] == short[short.index("-filter_complex") + 1]
    assert short.index("-ss") > short.index("-filter_complex")
    assert short[short.index("-ss") + 1] == "3.000"
    assert short_total == min(5, total - 3)
    with pytest.raises(ValueError):
        build_command(replace(req, output_start=total))


@pytest.mark.parametrize("audio_mode", ["source", "silent", "voiceover"])
def test_real_preview_matches_full_render_window(tmp_path, monkeypatch, audio_mode):
    from app import jobs
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    monkeypatch.setattr(jobs.assets, "fonts_dir", lambda: fonts)
    source = tmp_path / "source.mp4"
    audio_input = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] if audio_mode == "source" else []
    run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", *audio_input,
                "-t", "12", "-c:v", "libx264", "-c:a", "aac", str(source)])
    vo = tmp_path / "vo.wav"
    run_ffmpeg(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "12", str(vo)])
    image = tmp_path / "overlay.png"
    run_ffmpeg(["-f", "lavfi", "-i", "color=red:size=32x32", "-frames:v", "1", str(image)])
    monkeypatch.setattr(jobs.assets, "resolve_track", lambda *_: vo)
    monkeypatch.setattr(jobs.assets, "resolve_overlay", lambda *_: image)
    plan = {"operations": [
        {"type": "trim", "start": 1, "end": 11}, {"type": "cut_range", "start": 4, "end": 5},
        {"type": "speed", "factor": 1.25}, {"type": "transition", "duration": 0.5},
        {"type": "color_grade", "preset": "warm"}, {"type": "fade", "fade_in": 0.5, "fade_out": 0.5},
        {"type": "subtitles", "style": "classic"},
        {"type": "text", "text": "Preview", "start": 2, "duration": 3},
        {"type": "overlay", "track": "image", "start": 1, "duration": 4, "mode": "sticker"},
        {"type": "music", "track": "music", "volume": 0.1, "ducking": True},
        {"type": "sfx", "track": "ding", "at": 3, "volume": 0.1},
    ]}
    transcript = {"segments": [{"id": 1, "start": 5.5, "end": 8, "text": "A real caption", "words": [
        {"text": "A", "start": 5.5, "end": 6}, {"text": "real", "start": 6, "end": 7},
        {"text": "caption", "start": 7, "end": 8},
    ]}]}
    p = Project(id="preview", name="Test", status="ready", source_file="source.mp4", duration=12,
                width=160, height=90, has_audio=audio_mode == "source", plan=plan, subtitles=transcript,
                voiceover_file="vo.wav" if audio_mode == "voiceover" else None,
                output_file="outputs/preserved.mp4", output_meta={"test": True})
    snapshot = p.model_dump()
    before = copy.deepcopy(snapshot)
    result = jobs.task_preview(lambda *_: None, snapshot, {"start": 1.5, "duration": 5})
    assert snapshot == before
    assert p.output_file == "outputs/preserved.mp4" and p.output_meta == {"test": True}
    assert result["start"] == 1.5 and result["duration"] == 5
    assert result["render_revision"] == jobs.render_revision(p)
    output = tmp_path / result["output"].split("/projects/preview/")[1]
    assert probe(output).duration == pytest.approx(5, abs=0.12)
    # Render the same unmodified plan in full and compare actual decoded frames,
    # including a transition, timed ASS captions/text, fades and image layers.
    parsed = EditPlan.model_validate(plan)
    full = tmp_path / "full.mp4"
    req = RenderRequest(source=source, info=jobs.media_info(p), plan=parsed, timeline=jobs.project_timeline(p),
                        transcript=transcript, output=full, work_dir=tmp_path / "full-work", fonts_dir=fonts,
                        resolve_track=lambda _: vo, resolve_overlay=lambda _: image,
                        voiceover=vo if audio_mode == "voiceover" else None)
    render(req, lambda _: None)
    for index, t in enumerate([0.5, 1.0, 3.0, 4.8]):
        def frame(file, at: float, label: str) -> bytes:
            raw = tmp_path / f"{label}_{index}_{at}.rgb"
            run_ffmpeg(["-ss", str(at), "-i", str(file), "-frames:v", "1", "-pix_fmt", "rgb24",
                        "-f", "rawvideo", str(raw)])
            return raw.read_bytes()

        short = frame(output, t, "short")
        # Container timestamps can land on the neighbouring frame when the preview
        # and the full render are seeked separately. Accept the best of ±1 frame;
        # genuinely different content still exceeds the threshold at every offset.
        errors = []
        for offset in (-1 / 30, 0, 1 / 30):
            full_frame = frame(full, t + 1.5 + offset, f"full_{offset:+.4f}")
            assert len(short) == len(full_frame) == 160 * 90 * 3
            errors.append(sum(abs(a - b) for a, b in zip(short, full_frame)) / len(short))
        assert min(errors) < 8, f"frame at {t}: mean channel error {min(errors)}"
    samples = []
    for label, file, at in [("short", output, 0), ("full", full, 1.5)]:
        raw = tmp_path / f"{label}.pcm"
        run_ffmpeg(["-ss", str(at), "-i", str(file), "-t", "5", "-vn", "-ac", "1", "-ar", "48000",
                    "-c:a", "pcm_f32le", "-f", "f32le", str(raw)])
        values = array("f")
        values.frombytes(raw.read_bytes())
        samples.append(values)
    # Compare with the full render's actual audio stream, which may end before
    # its video (e.g. short voiceovers). AAC packet padding can differ slightly.
    assert min(map(len, samples)) > 0
    assert abs(len(samples[0]) - len(samples[1])) <= 2048
    audio_error = sum(abs(a - b) for a, b in zip(*samples)) / min(map(len, samples))
    assert audio_error < 0.02, f"mean audio error {audio_error}"


@pytest.mark.parametrize("speed,vo_duration", [(2, 8), (0.5, 8), (1, 8), (2, 2)])
def test_voiceover_speed_preserves_available_audio_and_preview(tmp_path, speed, vo_duration):
    """Trim narration on the pre-speed clock; never invent missing speech."""
    source = tmp_path / "source.mp4"
    vo = tmp_path / "voice.wav"
    run_ffmpeg(["-f", "lavfi", "-i", "color=blue:size=160x90:rate=30",
                "-t", "8", "-c:v", "libx264", str(source)])
    run_ffmpeg(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
                "-t", str(vo_duration), str(vo)])
    plan = EditPlan.model_validate({"operations": [
        {"type": "trim", "start": 1, "end": 8},
        {"type": "cut_range", "start": 3, "end": 4},
        {"type": "transition", "duration": 0.4},
        {"type": "speed", "factor": speed},
    ]})
    timeline = build_timeline(plan, 8)
    req = RenderRequest(source=source, info=probe(source), plan=plan, timeline=timeline,
                        transcript=None, output=tmp_path / "full.mp4", work_dir=tmp_path / "work",
                        fonts_dir=tmp_path, resolve_track=lambda _: None, voiceover=vo)
    render(req, lambda _: None)
    expected = min(vo_duration / speed, timeline.output_duration)
    full_pcm = tmp_path / "full.pcm"
    run_ffmpeg(["-i", str(req.output), "-vn", "-ac", "1", "-ar", "48000",
                "-c:a", "pcm_f32le", "-f", "f32le", str(full_pcm)])
    full_values = array("f")
    full_values.frombytes(full_pcm.read_bytes())
    assert len(full_values) / 48000 == pytest.approx(expected, abs=0.12)
    # Late preview must include the same narration, not only the first half.
    start = max(0, expected - 0.6)
    short = replace(req, output=tmp_path / "preview.mp4", work_dir=tmp_path / "short-work",
                    output_start=start, output_duration=0.4)
    render(short, lambda _: None)
    preview_pcm = tmp_path / "preview.pcm"
    run_ffmpeg(["-i", str(short.output), "-vn", "-ac", "1", "-ar", "48000",
                "-c:a", "pcm_f32le", "-f", "f32le", str(preview_pcm)])
    values = array("f")
    values.frombytes(preview_pcm.read_bytes())
    assert len(values) / 48000 == pytest.approx(0.4, abs=0.08)
    assert sum(abs(v) for v in values) / len(values) > 0.02


def test_preview_tail_unique_files_and_no_project_writes(tmp_path, monkeypatch):
    from app import jobs
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    monkeypatch.setattr(jobs.assets, "fonts_dir", lambda: tmp_path)
    def forbidden(*_):
        pytest.fail("Preview must never update the project")
    monkeypatch.setattr(jobs, "_save_project", forbidden)
    seen = []
    def fake_render(req, _):
        seen.append(req)
        return {"duration": req.output_duration, "width": 160, "height": 90}
    monkeypatch.setattr(jobs, "render", fake_render)
    monkeypatch.setattr(jobs, "probe", lambda _: MediaInfo(2, 160, 90, 30, True, True))
    p = Project(name="Test", source_file="source.mp4", duration=12, status="ready")
    first = jobs.task_preview(lambda *_: None, p.model_dump(), {"start": 10})
    second = jobs.task_preview(lambda *_: None, p.model_dump(), {"start": 10})
    assert first["output"] != second["output"]
    assert first["duration"] == 2 and first["end"] == 12
    assert seen[0].output_start == 10 and seen[0].output_duration == 2


def test_failed_preview_removes_partial_file(tmp_path, monkeypatch):
    from app import jobs
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    monkeypatch.setattr(jobs.assets, "fonts_dir", lambda: tmp_path)
    paths = []
    def fail(req, _):
        req.output.parent.mkdir(parents=True, exist_ok=True)
        req.output.write_bytes(b"partial")
        paths.append(req.output)
        raise RuntimeError("render failed")
    monkeypatch.setattr(jobs, "render", fail)
    p = Project(name="Test", source_file="source.mp4", duration=12, status="ready")
    with pytest.raises(RuntimeError, match="render failed"):
        jobs.task_preview(lambda *_: None, p.model_dump(), {})
    assert not paths[0].exists()
