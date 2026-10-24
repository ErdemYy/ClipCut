"""Precise subtitle edits, validation, stale-save safety and render/export boundaries."""
from __future__ import annotations

import copy

import pytest
from pydantic import ValidationError

from app.edit.schema import EditPlan, SubtitlesOp
from app.edit.timeline import build_timeline
from app.subtitles.builder import build_ass, cues_for_export, distribute_words, map_words, to_srt, transcript_words
from app.subtitles.editor import SubtitlesBody, normalized_segments, subtitle_revision, subtitle_time_limit
from .test_publishing import isolated_api  # noqa: F401


def rows():
    return [
        {"id": 0, "start": 1, "end": 2, "text": "Merhaba dünya", "words": [
            {"text": "Merhaba", "start": 1, "end": 1.35}, {"text": "dünya", "start": 1.5, "end": 2},
        ]},
        {"id": 1, "start": 3, "end": 4, "text": "İkinci satır.", "words": [
            {"text": "İkinci", "start": 3, "end": 3.2}, {"text": "satır.", "start": 3.3, "end": 4},
        ]},
    ]


@pytest.fixture
def subtitle_api(isolated_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, captures = isolated_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.transcript = {"language": "tr", "segments": rows(), "timing_basis": "source"}
        p.subtitles = {"language": "tr", "segments": rows(), "mock": True}
        p.subtitle_language = "tr"
        p.output_file = "outputs/existing.mp4"
        session.add(p)
        session.commit()
    return client, engine, captures


@pytest.mark.parametrize("change", [
    {"start": float("nan")}, {"end": float("inf")}, {"id": -1}, {"id": True}, {"text": "  "},
    {"words": []}, {"words": [{"text": "x", "start": 1, "end": float("nan")}]},
])
def test_editor_schema_rejects_invalid_values(change):
    with pytest.raises(ValidationError):
        SubtitlesBody(segments=[{**rows()[0], **change}])


@pytest.mark.parametrize("kind", ["reversed", "outside", "duplicate", "overlap", "word_overlap", "word_outside", "word_reversed", "mismatch"])
def test_normalizer_rejects_unsafe_timings(kind):
    segments = rows()
    if kind == "reversed": segments[0]["end"] = 0.5
    if kind == "outside": segments[1]["end"] = 20
    if kind == "duplicate": segments[1]["id"] = 0
    if kind == "overlap": segments[1]["start"] = 1.9
    if kind == "word_overlap": segments[0]["words"][1]["start"] = 1.2
    if kind == "word_outside": segments[0]["words"][0]["start"] = 0.9
    if kind == "word_reversed": segments[0]["words"][0]["end"] = 0.9
    if kind == "mismatch": segments[0]["text"] = "Farklı metin"
    with pytest.raises(ValueError):
        normalized_segments(SubtitlesBody(segments=segments), None, 10)


def test_explicit_words_and_legacy_requests_preserve_or_redistribute():
    previous = {"segments": rows()}
    original = copy.deepcopy(previous)
    explicit = normalized_segments(SubtitlesBody(segments=rows()), previous, 10)
    assert explicit == rows()
    legacy = [{key: row[key] for key in ("id", "start", "end", "text")} for row in rows()]
    assert normalized_segments(SubtitlesBody(segments=legacy), previous, 10) == rows()
    legacy[0]["text"] = "Yeni metin burada"
    changed = normalized_segments(SubtitlesBody(segments=legacy), previous, 10)
    assert len(changed[0]["words"]) == 3
    assert changed[0]["words"][0]["start"] == 1 and changed[0]["words"][-1]["end"] == pytest.approx(2)
    assert previous == original
    assert "break_before" not in distribute_words("unchanged format", 0, 1)[0].__dict__


def test_revision_and_existing_voiceover_extent():
    snapshot = {"source_file": "source.mp4", "duration": 5, "subtitles": {"segments": rows()}}
    revision = subtitle_revision(snapshot)
    assert subtitle_revision({**snapshot, "duration": 5.0, "plan": {"operations": []}}) == revision
    assert subtitle_revision({**snapshot, "source_file": "new.mp4"}) != revision
    assert subtitle_revision({**snapshot, "subtitles": {"segments": []}}) != revision
    assert subtitle_time_limit(snapshot) == 5
    snapshot["voiceover_file"] = "voiceover.mp3"
    snapshot["transcript"] = {"segments": [{"end": 8}, {"end": float("inf")}]}
    assert subtitle_time_limit(snapshot) == 8


def test_precise_save_roundtrip_and_no_source_or_plan_changes(subtitle_api):
    client, _, _ = subtitle_api
    before = client.get("/api/projects/video").json()
    changed = rows()
    changed[0]["words"][0]["end"] = 1.25
    response = client.put("/api/projects/video/subtitles", json={"segments": changed, "revision": before["subtitle_revision"]})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["subtitles"]["segments"] == changed
    assert saved["subtitles"]["manual_segments"] and saved["subtitles"]["mock"]
    assert saved["subtitle_revision"] != before["subtitle_revision"]
    assert saved["render_revision"] != before["render_revision"]
    assert saved["plan"] == before["plan"] and saved["source_url"] == before["source_url"] and saved["output_url"] == before["output_url"]
    assert not saved["can_undo"]  # Subtitle edits do not pollute video-plan history.
    assert client.get("/api/projects/video/transcript-edit").json()["segments"][0]["end"] == 2
    assert client.put("/api/projects/video/subtitles", json={"segments": rows(), "revision": before["subtitle_revision"]}).status_code == 409
    assert client.get("/api/projects/video").json()["subtitles"]["segments"] == changed


def test_api_rejects_invalid_ranges_and_active_subtitle_jobs(subtitle_api):
    from sqlmodel import Session
    from app.models import Job, Project

    client, engine, _ = subtitle_api
    bad = rows()
    bad[0]["end"] = 0.5
    assert client.put("/api/projects/video/subtitles", json={"segments": bad}).status_code == 422
    assert client.put("/api/projects/missing/subtitles", json={"segments": rows()}).status_code == 404
    with Session(engine) as session:
        session.add(Job(project_id="video", kind="translate", status="running"))
        session.commit()
    assert client.put("/api/projects/video/subtitles", json={"segments": rows()}).status_code == 409
    with Session(engine) as session:
        p = session.get(Project, "silent")
        p.status = "generating"
        session.add(p)
        session.commit()
    assert client.put("/api/projects/silent/subtitles", json={"segments": []}).status_code == 409


def split_rows():
    return [
        {"id": 0, "start": 1, "end": 1.2, "text": "Kısa.", "words": [{"text": "Kısa.", "start": 1, "end": 1.2}]},
        {"id": 1, "start": 1.3, "end": 1.5, "text": "Satır.", "words": [{"text": "Satır.", "start": 1.3, "end": 1.5}]},
    ]


def test_split_merge_and_short_timings_survive_ass_srt_and_mapping():
    transcript = {"manual_segments": True, "segments": split_rows()}
    words = transcript_words(transcript)
    cues = cues_for_export(words)
    assert [(cue.start, cue.end) for cue in cues] == [(1, 1.2), (1.3, 1.5)]
    assert to_srt(cues).count("-->") == 2
    ass = build_ass(320, 180, words, SubtitlesOp(style="classic"), [])
    assert "0:00:01.00,0:00:01.20" in ass and "0:00:01.30,0:00:01.50" in ass
    merged = {"manual_segments": True, "segments": [{"id": 0, "start": 1, "end": 1.5, "text": "Kısa. Satır.", "words": [
        *split_rows()[0]["words"], *split_rows()[1]["words"],
    ]}]}
    assert len(cues_for_export(transcript_words(merged))) == 1  # Explicit merge overrides punctuation grouping.
    timeline = build_timeline(EditPlan.model_validate({"operations": [{"type": "trim", "start": 1, "end": 2}, {"type": "speed", "factor": 2}]}), 3)
    shifted = cues_for_export(map_words(words, timeline))
    assert shifted[0].start == 0 and shifted[0].end == pytest.approx(0.1)
    assert shifted[1].start == pytest.approx(0.15)


def test_removed_first_word_carries_manual_boundary():
    tr = {"manual_segments": True, "segments": rows()}
    timeline = build_timeline(EditPlan.model_validate({"operations": [{"type": "cut_range", "start": 3, "end": 3.3}]}), 6)
    cues = cues_for_export(map_words(transcript_words(tr), timeline))
    assert len(cues) == 2 and cues[1].text == "satır."


def test_split_and_merge_exports_use_saved_boundaries(subtitle_api):
    client, _, _ = subtitle_api
    assert client.put("/api/projects/video/subtitles", json={"segments": split_rows()}).status_code == 200
    srt = client.get("/api/projects/video/subtitles.srt?edited=false")
    vtt = client.get("/api/projects/video/subtitles.vtt?edited=false")
    assert srt.status_code == vtt.status_code == 200
    assert srt.text.count("-->") == vtt.text.count("-->") == 2
    assert "00:00:01,000 --> 00:00:01,200" in srt.text
    words = [*split_rows()[0]["words"], *split_rows()[1]["words"]]
    assert client.put("/api/projects/video/subtitles", json={"segments": [{"id": 0, "start": 1, "end": 1.5, "text": "Kısa. Satır.", "words": words}]}).status_code == 200
    assert client.get("/api/projects/video/subtitles.srt?edited=false").text.count("-->") == 1


def test_real_render_respects_short_manual_caption_windows(subtitle_api, tmp_path, monkeypatch):
    from sqlmodel import Session
    from app import jobs
    from app.ffmpeg import probe, run_ffmpeg
    from app.models import Project

    client, engine, _ = subtitle_api
    monkeypatch.setattr(jobs, "engine", engine)
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    monkeypatch.setattr(jobs.assets, "fonts_dir", lambda: fonts)
    source = tmp_path / "source.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "color=blue:size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                "-t", "3", "-c:v", "libx264", "-c:a", "aac", str(source)])
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.width, p.height, p.duration = 160, 90, 3
        p.plan = {"operations": [{"type": "subtitles", "style": "classic"}]}
        session.add(p)
        session.commit()
    assert client.put("/api/projects/video/subtitles", json={"segments": split_rows()}).status_code == 200
    result = jobs.task_render(lambda *_: None, "video")
    output = tmp_path / result["output"].split("/projects/video/")[1]
    assert probe(output).duration == pytest.approx(3, abs=0.15)
    counts = []
    for index, at in enumerate([0.8, 1.1, 1.25, 1.4, 1.8]):
        raw = tmp_path / f"frame_{index}.rgb"
        run_ffmpeg(["-ss", str(at), "-i", str(output), "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", str(raw)])
        pixels = raw.read_bytes()
        counts.append(sum(pixels[i] > 160 and pixels[i + 1] > 160 for i in range(0, len(pixels), 3)))
    assert counts[1] > 5 and counts[3] > 5, counts  # Text appears inside both saved windows.
    assert counts[0] < 3 and counts[2] < 3 and counts[4] < 3, counts  # No old 0.6s cue extension.
