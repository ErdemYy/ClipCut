"""Source-transcript edits: trustworthy selection, undo and independent real clips."""
from __future__ import annotations

import copy
import zipfile

import pytest
from pydantic import ValidationError

from app.edit.schema import EditPlan
from app.edit.timeline import build_timeline
from app.transcript_edit import (TranscriptClipBody, TranscriptSelection, clip_selection,
                                  cut_selection, selected_rows, transcript_view)
from .test_publishing import isolated_api  # noqa: F401


def transcript():
    return {"language": "tr", "timing_basis": "source", "segments": [
        {"id": 99, "start": 0, "end": 2, "text": "İlk cümle."},
        {"id": 99, "start": 2, "end": 4, "text": "İkinci cümle."},
        {"id": 99, "start": 4, "end": 6, "text": "Son cümle."},
    ]}


@pytest.fixture
def transcript_api(isolated_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, captures = isolated_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.duration = 6
        p.transcript = transcript()
        p.subtitles = {"language": "en", "segments": [{"id": 0, "start": 0, "end": 6, "text": "Translated text"}]}
        p.output_file = "outputs/keep.mp4"
        session.add(p)
        session.commit()
    return client, engine, captures


def test_schema_requires_server_revision_and_real_indices():
    revision = "a" * 64
    assert TranscriptSelection(revision=revision, segment_ids=[2, 0, 2]).segment_ids == [0, 2]
    for patch in ({"segment_ids": []}, {"segment_ids": [-1]}, {"segment_ids": [True]},
                  {"segment_ids": [0.5]}, {"revision": "old"}, {"start": 1, "end": 5}):
        with pytest.raises(ValidationError):
            TranscriptSelection.model_validate({"revision": revision, "segment_ids": [0], **patch})
    with pytest.raises(ValidationError):
        TranscriptClipBody(revision=revision, segment_ids=[0], fill="unknown")


def test_source_rows_ignore_translation_and_untrusted_ids(transcript_api):
    client, _, _ = transcript_api
    data = client.get("/api/projects/video/transcript-edit").json()
    assert [row["text"] for row in data["segments"]] == ["İlk cümle.", "İkinci cümle.", "Son cümle."]
    assert [row["id"] for row in data["segments"]] == [0, 1, 2]
    assert data["blocked_reason"] is None
    assert client.get("/api/projects/missing/transcript-edit").status_code == 404


def test_cut_round_trip_rejects_stale_and_keeps_source_and_transcript(transcript_api):
    client, _, _ = transcript_api
    before = client.get("/api/projects/video").json()
    data = client.get("/api/projects/video/transcript-edit").json()
    body = {"revision": data["revision"], "segment_ids": [1]}
    result = client.post("/api/projects/video/transcript-edit/cut", json=body)
    assert result.status_code == 200
    p = result.json()
    assert p["source_url"] == before["source_url"] and p["output_url"] == before["output_url"]
    assert p["subtitles"] == before["subtitles"] and p["can_undo"]
    assert p["plan"]["operations"] == [{"type": "cut_range", "start": 2, "end": 4}]
    assert client.get("/api/projects/video/timeline").json()["output_duration"] == 4
    assert client.post("/api/projects/video/transcript-edit/cut", json=body).status_code == 409
    after = client.get("/api/projects/video/transcript-edit").json()
    assert after["segments"][1]["kept_duration"] == 0
    assert after["segments"][1]["text"] == "İkinci cümle."
    assert client.post("/api/projects/video/transcript-edit/cut", json={"revision": after["revision"], "segment_ids": [1]}).status_code == 422
    undo = client.post("/api/projects/video/plan/undo")
    assert undo.status_code == 200 and undo.json()["plan"] == before["plan"]
    assert client.get("/api/projects/video/timeline").json()["output_duration"] == 6


def test_all_video_and_forged_ranges_are_rejected_without_history(transcript_api):
    client, _, _ = transcript_api
    data = client.get("/api/projects/video/transcript-edit").json()
    for ids in ([0, 1, 2], [100]):
        response = client.post("/api/projects/video/transcript-edit/cut", json={"revision": data["revision"], "segment_ids": ids})
        assert response.status_code == 422
    assert client.post("/api/projects/video/transcript-edit/cut", json={"revision": data["revision"], "segment_ids": [0], "start": 0, "end": 6}).status_code == 422
    assert not client.get("/api/projects/video").json()["can_undo"]


def test_clip_selection_contiguous_and_snapshot_only(transcript_api):
    client, _, captures = transcript_api
    before = client.get("/api/projects/video").json()
    view = client.get("/api/projects/video/transcript-edit").json()
    endpoint = "/api/projects/video/transcript-edit/clip"
    assert client.post(endpoint, json={"revision": view["revision"], "segment_ids": [0, 2]}).status_code == 422
    response = client.post(endpoint, json={"revision": view["revision"], "segment_ids": [1, 2], "resolution": "720p"})
    assert response.status_code == 200
    assert captures[-1][0] == "transcript_clip"
    snapshot, options, clips = captures[-1][1]
    assert clips == [{"id": 0, "start": 2, "end": 6}]
    assert options["resolution"] == "720p" and options["aspect_ratio"] == "9:16"
    assert snapshot["source_file"] == "source.mp4"
    assert client.get("/api/projects/video").json() == before


@pytest.mark.parametrize("kind", ["active", "removed", "legacy"])
def test_voiceover_transcript_cannot_cut_source_after_removal(transcript_api, kind):
    from sqlmodel import Session
    from app.models import Project

    client, engine, _ = transcript_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        tr = transcript()
        if kind == "active":
            p.voiceover_file = "voiceover.mp3"
        elif kind == "removed":
            tr["timing_basis"] = "voiceover"
        else:
            tr.pop("timing_basis")
            tr["words"] = []
        p.transcript = tr
        session.add(p)
        session.commit()
    view = client.get("/api/projects/video/transcript-edit").json()
    assert view["blocked_reason"]
    for action in ("cut", "clip"):
        assert client.post(f"/api/projects/video/transcript-edit/{action}", json={"revision": view["revision"], "segment_ids": [1]}).status_code == 422


def test_trim_speed_existing_cuts_and_invalid_segments():
    plan = EditPlan.model_validate({"operations": [
        {"type": "trim", "start": 1, "end": 6}, {"type": "speed", "factor": 2},
    ]})
    tl = build_timeline(plan, 6)
    snapshot = {"duration": 6, "transcript": transcript(), "plan": plan.model_dump()}
    view = transcript_view(snapshot, tl)
    rows = selected_rows(view, TranscriptSelection(revision=view["revision"], segment_ids=[1]))
    cut = cut_selection(plan, tl, rows)
    assert build_timeline(cut, 6).segments == [(1, 2), (4, 6)]
    assert build_timeline(cut, 6).output_duration == 1.5
    assert plan.first("cut_range") is None
    snapshot["transcript"]["segments"].extend([
        {"start": float("nan"), "end": 4, "text": "Bad"}, {"start": 8, "end": 9, "text": "Outside"},
        {"start": 3, "end": 2, "text": "Reversed"}, {"start": 1, "end": 1.01, "text": "Tiny"},
    ])
    assert len(transcript_view(snapshot, tl)["segments"]) == 3


def test_real_selected_clip_and_cut_render(transcript_api, tmp_path, monkeypatch):
    from sqlmodel import Session
    from app import jobs
    from app.ffmpeg import probe, run_ffmpeg
    from app.models import Project

    client, engine, captures = transcript_api
    monkeypatch.setattr(jobs, "engine", engine)
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    monkeypatch.setattr(jobs.assets, "fonts_dir", lambda: fonts)
    source = tmp_path / "source.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                "-t", "6", "-c:v", "libx264", "-c:a", "aac", str(source)])
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.width, p.height = 160, 90
        p.subtitles = p.transcript
        p.plan = {"operations": [{"type": "subtitles", "style": "classic"}]}
        session.add(p)
        session.commit()
        session.refresh(p)
        before = copy.deepcopy(p.model_dump())
    view = client.get("/api/projects/video/transcript-edit").json()
    response = client.post("/api/projects/video/transcript-edit/clip", json={"revision": view["revision"], "segment_ids": [1], "resolution": "720p", "quality": "fast"})
    assert response.status_code == 200
    snapshot, options, clips = captures[-1][1]
    result = jobs.task_publish(lambda *_: None, snapshot, options, clips)
    output = tmp_path / result["outputs"][0]["output"].split("/projects/video/")[1]
    info = probe(output)
    assert (info.width, info.height) == (720, 1280)
    assert info.duration == pytest.approx(2, abs=0.15) and info.has_audio
    with zipfile.ZipFile(tmp_path / result["archive"].split("/projects/video/")[1]) as archive:
        assert len(archive.namelist()) == 2
    with Session(engine) as session:
        assert session.get(Project, "video").model_dump() == before
    assert client.post("/api/projects/video/transcript-edit/cut", json={"revision": view["revision"], "segment_ids": [1]}).status_code == 200
    rendered = jobs.task_render(lambda *_: None, "video")
    cut_info = probe(tmp_path / rendered["output"].split("/projects/video/")[1])
    assert cut_info.duration == pytest.approx(4, abs=0.15) and cut_info.has_audio
