"""Publishing validation, local clip ranking, isolated API and real FFmpeg checks."""
from __future__ import annotations

import copy
import os
import zipfile
from pathlib import Path

import pytest
from pydantic import ValidationError

os.environ.setdefault("MOCK_AI", "true")

from app.edit.schema import EditPlan  # noqa: E402
from app.publishing import (  # noqa: E402
    BatchExportBody, ClipAnalyzeBody, ClipExportBody, ClipPreviewBody, ThumbnailBody, clip_plan, export_plan,
    rank_clips, sentence_boundaries,
)


def test_publish_validation():
    assert BatchExportBody(formats=["9:16", "9:16"]).formats == ["9:16"]
    for body in ({"formats": []}, {"formats": ["3:2"]}, {"quality": "ultra"},
                 {"resolution": "8k"}, {"thumbnail_at": float("nan")}):
        with pytest.raises(ValidationError):
            BatchExportBody.model_validate(body)
    for body in ({"min_duration": 20}, {"min_duration": 50, "max_duration": 40}, {"max_clips": 11}):
        with pytest.raises(ValidationError):
            ClipAnalyzeBody.model_validate(body)
    with pytest.raises(ValidationError):
        ThumbnailBody(at=float("inf"))
    with pytest.raises(ValidationError):
        ClipExportBody(analysis_id="../../file", clip_ids=[0])
    preview = ClipPreviewBody(analysis_id="abcdef123456", clip_id=0,
                              clip_range={"id": 0, "start": 30, "end": 65})
    assert preview.duration == 5 and preview.clip_range.start == 30
    for body in (
        {"analysis_id": "abcdef123456", "clip_id": 0, "duration": 6},
        {"analysis_id": "abcdef123456", "clip_id": 1, "clip_range": {"id": 0, "start": 30, "end": 65}},
        {"analysis_id": "../../file", "clip_id": 0},
    ):
        with pytest.raises(ValidationError):
            ClipPreviewBody.model_validate(body)


def test_format_plans_do_not_change_editor_plan():
    plan = EditPlan.model_validate({"operations": [
        {"type": "reframe", "aspect_ratio": "1:1"}, {"type": "speed", "factor": 2},
        {"type": "subtitles"}, {"type": "text", "text": "Title", "start": 4},
    ]})
    original = copy.deepcopy(plan.model_dump())
    for aspect in ("9:16", "1:1", "4:5", "16:9"):
        derived = export_plan(plan, aspect, "blur")
        assert derived.first("reframe").aspect_ratio == aspect
        assert derived.first("speed").factor == 2
        assert len(derived.all("reframe")) == 1
    clip = clip_plan(plan, 35, 65, "9:16", "blur")
    assert clip.first("trim").start == 35
    assert clip.first("speed") is None and clip.first("text") is None
    assert clip.first("subtitles") is not None
    assert plan.model_dump() == original


def test_clip_rank_bounds_nonoverlap_and_full_silence():
    opts = ClipAnalyzeBody(max_clips=5)
    result = rank_clips(180, [(0, 15), (65, 90), (150, 180)], opts)
    assert result
    for c in result:
        assert 0 <= c["start"] < c["end"] <= 180
        assert 30 <= c["duration"] <= 60
        assert 0 <= c["score"] <= 100
        assert c["speech_ratio"] >= 0.4
        assert c["words_per_minute"] is None
    assert all(a["end"] <= b["start"] for a, b in zip(result, result[1:]))
    assert rank_clips(90, [(0, 90)], opts) == []
    assert rank_clips(29.9, [], opts) == []
    assert len(rank_clips(30, [], opts)) == 1


def test_clip_ignores_mock_transcript_and_uses_real_tempo():
    tr = {"segments": [{"start": 0, "end": 30, "text": "word " * 60}]}
    result = rank_clips(30, [], ClipAnalyzeBody(), tr)
    assert result[0]["words_per_minute"] == 120
    assert result[0]["excerpt"]
    assert result[0]["transcript_used"] is True
    assert rank_clips(30, [], ClipAnalyzeBody(), {**tr, "mock": True})[0]["words_per_minute"] is None


def test_smart_clip_rejects_voiceover_transcript_provenance():
    tr = {
        "timing_basis": "voiceover",
        "segments": [{"start": 0, "end": 30, "text": "Neden bu yöntem daha iyi? Çünkü daha hızlı."}],
    }
    result = rank_clips(30, [], ClipAnalyzeBody(), tr)
    assert result and result[0]["transcript_used"] is False
    assert result[0]["sentence_aligned"] is False
    assert result[0]["hook_score"] is None and result[0]["topic_score"] is None
    assert result[0]["words_per_minute"] is None


def test_smart_clip_prefers_question_at_sentence_boundary():
    texts = [
        "Kahve hazırlamayı öğreneceğiz.",
        "Önce çekirdekleri tartıyoruz ve öğütüyoruz.",
        "Neden su sıcaklığı bu kadar önemli? Yanlış sıcaklık tadı bozar.",
        "Doksan derece su kullanın ve yavaş dökün.",
        "Dört dakika bekleyin, sonra servis edin.",
        "Sonuç gerçekten farklı olacak.",
        "Bu yöntemi her gün uygulayın.",
        "Şimdi deneyin ve yorum yazın.",
    ]
    segments = [{"start": index * 10, "end": index * 10 + 10, "text": text}
                for index, text in enumerate(texts)]
    result = rank_clips(80, [], ClipAnalyzeBody(min_duration=30, max_duration=30, max_clips=1),
                        {"segments": segments})
    assert len(result) == 1
    clip = result[0]
    assert clip["start"] == 20 and clip["end"] == 50
    assert clip["transcript_used"] is True and clip["sentence_aligned"] is True
    assert clip["hook_score"] >= 0.9
    assert "soru/merak kancası" in clip["reason"]
    assert clip["signals"]["completeness"] == 1.0
    assert 0 <= clip["topic_score"] <= 1


def test_sentence_boundaries_use_only_source_transcript():
    source = {"segments": [
        {"start": 0, "end": 10, "text": "Birinci cümle."},
        {"start": 10, "end": 20, "text": "İkinci cümle."},
    ]}
    assert sentence_boundaries(30, source) == {"starts": [0, 10], "ends": [10, 20]}
    assert sentence_boundaries(15, source) == {"starts": [0, 10], "ends": [10, 15]}
    assert sentence_boundaries(30, {**source, "mock": True}) == {"starts": [], "ends": []}
    assert sentence_boundaries(30, {**source, "timing_basis": "voiceover"}) == {"starts": [], "ends": []}


def test_clip_export_manual_ranges_are_validated():
    base = {"analysis_id": "abcdef123456", "clip_ids": [0]}
    body = ClipExportBody(**base, clip_ranges=[{"id": 0, "start": 40, "end": 75}])
    assert (body.clip_ranges[0].start, body.clip_ranges[0].end) == (40, 75)
    for ranges in (
        [{"id": 0, "start": 40, "end": 75}, {"id": 0, "start": 50, "end": 80}],
        [{"id": 0, "start": 50, "end": 40}],
        [{"id": 0, "start": 0, "end": 20}],
    ):
        with pytest.raises(ValidationError):
            ClipExportBody(**base, clip_ranges=ranges)
    with pytest.raises(ValidationError):
        ClipExportBody(**base, clip_ranges=[])


def test_smart_clip_fields_are_bounded_and_nonoverlapping():
    transcripts = {"segments": [
        {"start": index * 10, "end": index * 10 + 10,
         "text": "Konu maddesi {} ve önemli ayrıntılar.".format(index)}
        for index in range(18)
    ]}
    result = rank_clips(180, [(0, 15), (65, 90), (150, 180)], ClipAnalyzeBody(max_clips=5), transcripts)
    assert result
    for clip in result:
        assert 0 <= clip["score"] <= 100
        assert 0 <= clip["hook_score"] <= 1 and 0 <= clip["topic_score"] <= 1
        assert set(clip["signals"]) >= {"speech", "cadence", "boundary", "completeness", "hook", "topic"}
        assert clip["transcript_used"] is True and isinstance(clip["sentence_aligned"], bool)
        assert clip["reason"]
    assert all(a["end"] <= b["start"] for a, b in zip(result, result[1:]))


@pytest.fixture
def isolated_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlmodel import SQLModel, Session, create_engine
    from app import main
    from app.models import Job, Project, get_session

    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    def session_provider():
        with Session(engine) as session:
            yield session
    main.app.dependency_overrides[get_session] = session_provider
    captures = []
    def submit(pid, kind, fn, *args):
        captures.append((kind, args))
        return Job(project_id=pid, kind=kind)
    monkeypatch.setattr(main.jobs, "submit", submit)
    monkeypatch.setattr(main.jobs, "project_dir", lambda _: tmp_path)
    with Session(engine) as s:
        s.add(Project(id="video", name="Test", source_file="source.mp4", duration=120, has_audio=True, status="ready"))
        s.add(Project(id="silent", name="Silent", source_file="silent.mp4", duration=120, status="ready"))
        s.add(Project(id="short", name="Short", source_file="short.mp4", duration=10, has_audio=True, status="ready"))
        s.commit()
    client = TestClient(main.app)  # No lifespan: do not download assets or touch the user's database.
    try:
        yield client, engine, captures
    finally:
        client.close()
        main.app.dependency_overrides.clear()
        engine.dispose()


def test_export_api_snapshots_and_validation(isolated_api):
    client, _, captures = isolated_api
    assert client.post("/api/projects/video/export-batch", json={"formats": ["4:5", "16:9"], "resolution": "720p"}).status_code == 200
    kind, args = captures[-1]
    assert kind == "export_batch" and args[0]["source_file"] == "source.mp4"
    assert args[1]["formats"] == ["4:5", "16:9"]
    assert client.post("/api/projects/video/export-batch", json={"thumbnail_at": 120}).status_code == 422
    assert client.post("/api/projects/video/export-batch", json={"formats": []}).status_code == 422
    assert client.post("/api/projects/missing/export-batch", json={}).status_code == 404
    assert client.post("/api/projects/video/render").status_code == 200  # Old clients still work.
    assert client.post("/api/projects/video/render", json={"quality": "high"}).status_code == 200
    assert captures[-1][1][1]["quality"] == "high"


def test_clip_api_rejects_foreign_and_invented_candidates(isolated_api):
    from sqlmodel import Session
    from app.models import Job

    client, engine, captures = isolated_api
    assert client.post("/api/projects/video/clips/analyze", json={}).status_code == 200
    assert client.post("/api/projects/silent/clips/analyze", json={}).status_code == 422
    assert client.post("/api/projects/short/clips/analyze", json={}).status_code == 422
    with Session(engine) as s:
        s.add(Job(id="abcdef123456", project_id="video", kind="clip_analyze", status="done", result={
            "source_file": "source.mp4", "clips": [{"id": 0, "start": 30, "end": 65}],
        }))
        s.commit()
    body = {"analysis_id": "abcdef123456", "clip_ids": [0]}
    assert client.post("/api/projects/silent/clips/render", json=body).status_code == 422
    assert client.post("/api/projects/video/clips/render", json={**body, "clip_ids": [99]}).status_code == 422
    assert client.post("/api/projects/video/clips/render", json=body).status_code == 200
    assert captures[-1][0] == "clip_render"
    assert captures[-1][1][2][0]["start"] == 30
    manual = {**body, "clip_ranges": [{"id": 0, "start": 40, "end": 75}]}
    assert client.post("/api/projects/video/clips/render", json=manual).status_code == 200
    assert (captures[-1][1][2][0]["start"], captures[-1][1][2][0]["end"]) == (40, 75)
    assert client.post("/api/projects/video/clips/render",
                       json={**manual, "clip_ranges": [{"id": 9, "start": 40, "end": 75}]}).status_code == 422
    assert client.post("/api/projects/video/clips/render",
                       json={**manual, "clip_ranges": [{"id": 0, "start": 100, "end": 135}]}).status_code == 422
    preview = {"analysis_id": "abcdef123456", "clip_id": 0}
    assert client.post("/api/projects/silent/clips/preview", json=preview).status_code == 422
    assert client.post("/api/projects/video/clips/preview", json={**preview, "clip_id": 99}).status_code == 422
    assert client.post("/api/projects/video/clips/preview", json=preview).status_code == 200
    assert captures[-1][0] == "clip_preview"
    assert (captures[-1][1][2]["start"], captures[-1][1][2]["end"]) == (30, 65)
    preview_manual = {**preview, "clip_range": {"id": 0, "start": 40, "end": 75}}
    assert client.post("/api/projects/video/clips/preview", json=preview_manual).status_code == 200
    assert (captures[-1][1][2]["start"], captures[-1][1][2]["end"]) == (40, 75)
    assert client.post("/api/projects/video/clips/preview",
                       json={**preview_manual, "clip_range": {"id": 9, "start": 40, "end": 75}}).status_code == 422
    assert client.post("/api/projects/video/clips/preview",
                       json={**preview_manual, "clip_range": {"id": 0, "start": 100, "end": 135}}).status_code == 422


def test_thumbnail_api_uses_unique_frame_and_checks_source_time(isolated_api, monkeypatch):
    from app import main

    client, _, _ = isolated_api
    calls = []
    monkeypatch.setattr(main, "make_thumbnail", lambda src, dst, at: calls.append((dst.name, at)))
    first = client.put("/api/projects/video/thumbnail", json={"at": 12.3})
    second = client.put("/api/projects/video/thumbnail", json={"at": 12.3})
    assert first.status_code == second.status_code == 200
    assert first.json()["thumbnail_url"] != second.json()["thumbnail_url"]
    assert calls[0][1] == 12.3
    assert client.put("/api/projects/video/thumbnail", json={"at": 120}).status_code == 422


def test_download_is_attachment_and_cannot_escape_project(isolated_api, tmp_path):
    client, _, _ = isolated_api
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "test.mp4").write_bytes(b"test-video")
    (tmp_path / "private.txt").write_text("private")
    response = client.get("/api/projects/video/download/outputs/test.mp4")
    assert response.status_code == 200 and response.content == b"test-video"
    assert "attachment" in response.headers["content-disposition"]
    assert client.get("/api/projects/video/download/private.txt").status_code == 404
    assert client.get("/api/projects/video/download/..%5Cprivate.mp4").status_code == 404


def test_real_four_format_batch_and_archive(tmp_path, monkeypatch):
    from app import jobs
    from app.ffmpeg import probe, run_ffmpeg
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    source = tmp_path / "source.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "0.8", "-c:v", "libx264", str(source)])
    p = Project(id="test", name="Batch", source_file="source.mp4", duration=0.8, width=160, height=90, status="ready")
    before = copy.deepcopy(p.plan)
    result = jobs.task_publish(lambda *_: None, p.model_dump(), BatchExportBody(resolution="720p", quality="fast").model_dump())
    expected = [(720, 1280), (720, 720), (720, 900), (1280, 720)]
    for out, dimensions in zip(result["outputs"], expected):
        path = tmp_path / out["output"].split("/projects/test/")[1]
        info = probe(path)
        assert (info.width, info.height) == dimensions
        assert info.has_audio and info.duration == pytest.approx(0.8, abs=0.15)
        thumb = tmp_path / out["thumbnail"].split("/projects/test/")[1]
        assert thumb.stat().st_size > 0
    archive = tmp_path / result["archive"].split("/projects/test/")[1]
    with zipfile.ZipFile(archive) as zf:
        assert len(zf.namelist()) == 8
        assert all("/" not in name for name in zf.namelist())
    assert p.plan == before


def test_clip_preview_uses_full_style_and_short_output_window(tmp_path, monkeypatch):
    from app import jobs
    from app.ffmpeg import MediaInfo
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    p = Project(
        id="test", name="Preview", source_file="source.mp4", duration=80, width=640, height=360,
        has_audio=True, status="ready", subtitles={"segments": [{"start": 0, "end": 80, "text": "Deneme."}]},
        plan={"operations": [{"type": "subtitles"}, {"type": "color_grade", "preset": "warm"}]},
    )
    captured = {}
    def fake_render(req, progress):
        captured.update(plan=req.plan, output_start=req.output_start,
                        output_duration=req.output_duration, transcript=req.transcript)
        req.output.parent.mkdir(parents=True, exist_ok=True)
        req.output.write_bytes(b"video")
        return {"duration": req.output_duration, "width": 720, "height": 1280}
    monkeypatch.setattr(jobs, "render", fake_render)
    monkeypatch.setattr(jobs, "probe", lambda _: MediaInfo(
        duration=5, width=720, height=1280, fps=30, has_audio=True, has_video=True))
    options = ClipPreviewBody(analysis_id="abcdef123456", clip_id=2, resolution="720p",
                              quality="fast", fill="crop").model_dump()
    result = jobs.task_preview_clip(lambda *_: None, p.model_dump(), options,
                                    {"id": 2, "start": 10, "end": 40})
    assert captured["output_start"] == 0 and captured["output_duration"] == 5
    assert captured["transcript"] == p.subtitles
    plan = captured["plan"]
    assert plan.first("trim").start == 10 and plan.first("trim").end == 40
    assert plan.first("subtitles") is not None and plan.first("color_grade") is not None
    assert plan.first("reframe").aspect_ratio == "9:16" and plan.first("reframe").mode == "crop"
    assert result["clip_id"] == 2 and result["analysis_id"] == "abcdef123456"
    assert (result["start"], result["end"], result["duration"]) == (10, 15, 5)
    assert result["clip_end"] == 40 and result["fill"] == "crop"


def test_real_clip_from_source_time(tmp_path, monkeypatch):
    from app import jobs
    from app.ffmpeg import probe, run_ffmpeg
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    source = tmp_path / "source.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "color=c=blue:size=96x54:rate=5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
                "-t", "36", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(source)])
    p = Project(id="test", name="Clip", source_file="source.mp4", duration=36, width=96, height=54, has_audio=True, status="ready")
    analysis = jobs.task_analyze_clips(lambda *_: None, p.model_dump(), ClipAnalyzeBody().model_dump())
    assert analysis["method"] == "local_speech_activity" and analysis["clips"]
    assert analysis["scoring"] == "smart_local_v1" and analysis["transcript_used"] is False
    assert analysis["clips"][0]["speech_ratio"] > 0.95
    assert analysis["clips"][0]["transcript_used"] is False
    options = ClipExportBody(analysis_id="abcdef123456", clip_ids=[0], resolution="720p", quality="fast").model_dump()
    result = jobs.task_publish(lambda *_: None, p.model_dump(), options, [{"id": 0, "start": 5, "end": 35}])
    out = result["outputs"][0]
    info = probe(tmp_path / out["output"].split("/projects/test/")[1])
    assert (info.width, info.height) == (720, 1280)
    assert info.duration == pytest.approx(30, abs=0.15)
    assert info.has_audio and out["start"] == 5
    preview = jobs.task_preview_clip(
        lambda *_: None, p.model_dump(),
        ClipPreviewBody(analysis_id="abcdef123456", clip_id=0, resolution="720p", quality="fast").model_dump(),
        {"id": 0, "start": 5, "end": 35},
    )
    preview_info = probe(tmp_path / preview["output"].split("/projects/test/")[1])
    assert (preview_info.width, preview_info.height) == (720, 1280)
    assert preview_info.duration == pytest.approx(5, abs=0.25)
    assert preview_info.has_audio and preview["clip_end"] == 35


def test_batch_maps_selected_cover_after_trim_and_speed(tmp_path, monkeypatch):
    from app import jobs
    from app.models import Project

    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    p = Project(id="test", name="Trimmed", source_file="source.mp4", duration=120, status="ready", plan={"operations": [
        {"type": "trim", "start": 20, "end": 80}, {"type": "speed", "factor": 2},
    ]})
    frames = []
    def fake_render(req, progress):
        req.output.write_bytes(b"video")
        return {"duration": req.timeline.output_duration, "width": 720, "height": 1280}
    def fake_thumbnail(src, dst, at):
        frames.append(at)
        dst.write_bytes(b"frame")
    monkeypatch.setattr(jobs, "render", fake_render)
    monkeypatch.setattr(jobs, "make_thumbnail", fake_thumbnail)
    settings = BatchExportBody(formats=["9:16"], thumbnail_at=40).model_dump()
    result = jobs.task_publish(lambda *_: None, p.model_dump(), settings)
    assert frames[-1] == 10
    assert not result["outputs"][0]["thumbnail_fallback"]
    result = jobs.task_publish(lambda *_: None, p.model_dump(), {**settings, "thumbnail_at": 5})
    assert frames[-1] == 0
    assert result["outputs"][0]["thumbnail_fallback"]
