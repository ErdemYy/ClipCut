"""Output-clock layer edits and bounded, cached source-waveform extraction."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import struct

import pytest
from pydantic import ValidationError

from app.edit.layers import LayerTimingsBody, timeline_revision
from app.ffmpeg import probe, run_ffmpeg
from app.waveform import BINS, SourceChangedError, pcm_peaks, source_waveform
from .test_publishing import isolated_api  # noqa: F401


@pytest.fixture
def layer_api(isolated_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, captures = isolated_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.duration = 12
        p.plan = {"operations": [
            {"type": "trim", "start": 2, "end": 10}, {"type": "cut_range", "start": 4, "end": 6},
            {"type": "speed", "factor": 2}, {"type": "transition", "duration": 0.5},
            {"type": "text", "text": "Title", "start": 0, "duration": 1},
            {"type": "overlay", "track": "image", "start": 1, "duration": 1},
            {"type": "music", "track": "music"},
        ]}
        p.output_file = "outputs/keep.mp4"
        session.add(p)
        session.commit()
    return client, engine, captures


@pytest.mark.parametrize("patch", [
    {"start": float("nan")}, {"start": float("inf")}, {"start": -1}, {"duration": 0.09},
    {"duration": 601}, {"duration": float("inf")}, {"index": True}, {"index": -1}, {"track": "forged"},
])
def test_layer_schema_rejects_untrusted_timing(patch):
    with pytest.raises(ValidationError):
        LayerTimingsBody(revision="a" * 64, layers=[{"index": 4, "start": 1, "duration": 1, **patch}])


def test_revision_uses_timeline_inputs_not_subtitle_cover_or_name():
    snapshot = {"source_file": "source.mp4", "duration": 12, "plan": {"operations": []}}
    revision = timeline_revision(snapshot)
    assert timeline_revision({**snapshot, "duration": 12.0, "name": "Renamed", "subtitles": {"segments": []}}) == revision
    assert timeline_revision({**snapshot, "source_file": "restored.mp4"}) != revision
    assert timeline_revision({**snapshot, "plan": {"operations": [{"type": "speed", "factor": 2}]}}) != revision


def test_batch_layer_edit_uses_output_clock_one_undo_and_preserves_other_ops(layer_api):
    client, _, captures = layer_api
    before = client.get("/api/projects/video").json()
    timeline = client.get("/api/projects/video/timeline").json()
    assert timeline["output_duration"] == 2.75 and timeline["revision"] == before["timeline_revision"]
    response = client.patch("/api/projects/video/timeline/layers", json={"revision": timeline["revision"], "layers": [
        {"index": 4, "start": 0.25, "duration": 1.25}, {"index": 5, "start": 1.5, "duration": 1.25},
    ]})
    assert response.status_code == 200, response.text
    after = response.json()
    assert after["plan"]["operations"][4]["start"] == 0.25
    assert after["plan"]["operations"][5]["duration"] == 1.25
    assert after["source_url"] == before["source_url"] and after["output_url"] == before["output_url"]
    assert after["subtitles"] == before["subtitles"]
    assert after["can_undo"] and after["render_revision"] != before["render_revision"]
    assert captures == []  # No paid AI call, export or render is submitted.
    undone = client.post("/api/projects/video/plan/undo").json()
    assert undone["plan"] == before["plan"] and not undone["can_undo"]


def test_api_rejects_stale_index_wrong_type_duplicates_and_source_time(layer_api):
    client, _, _ = layer_api
    before = client.get("/api/projects/video").json()
    revision = before["timeline_revision"]
    endpoint = "/api/projects/video/timeline/layers"
    for layers in ([{"index": 4, "start": 8, "duration": 1}], [{"index": 2, "start": 0, "duration": 1}],
                   [{"index": 99, "start": 0, "duration": 1}], [{"index": 4, "start": 0, "duration": 1}] * 2):
        assert client.patch(endpoint, json={"revision": revision, "layers": layers}).status_code == 422
    body = {"revision": revision, "layers": [{"index": 4, "start": 1, "duration": 1}]}
    assert client.patch(endpoint, json=body).status_code == 200
    assert client.patch(endpoint, json=body).status_code == 409
    assert client.patch("/api/projects/missing/timeline/layers", json=body).status_code == 404


def test_noop_is_not_added_to_history_and_unready_source_rejected(layer_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, _ = layer_api
    p = client.get("/api/projects/video").json()
    body = {"revision": p["timeline_revision"], "layers": [{"index": 4, "start": 0, "duration": 1}]}
    assert not client.patch("/api/projects/video/timeline/layers", json=body).json()["can_undo"]
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.status = "generating"
        session.add(p)
        session.commit()
    assert client.patch("/api/projects/video/timeline/layers", json=body).status_code == 409
    assert client.get("/api/projects/video/waveform").status_code == 409


def test_concurrent_layer_saves_accept_only_one_old_revision(layer_api):
    client, _, _ = layer_api
    revision = client.get("/api/projects/video").json()["timeline_revision"]
    def save(start):
        return client.patch("/api/projects/video/timeline/layers", json={"revision": revision,
            "layers": [{"index": 4, "start": start, "duration": 1}]}).status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(save, [0.25, 0.5])) == [200, 409]
    assert not client.post("/api/projects/video/plan/undo").json()["can_undo"]


def test_legacy_duplicate_singletons_cannot_silently_shift_layer_indices(layer_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, _ = layer_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.plan = {"operations": [{"type": "speed", "factor": 1}, {"type": "speed", "factor": 2},
                                 {"type": "text", "text": "First", "start": 0, "duration": 1},
                                 {"type": "text", "text": "Second", "start": 1, "duration": 1}]}
        session.add(p)
        session.commit()
    before = client.get("/api/projects/video").json()
    response = client.patch("/api/projects/video/timeline/layers", json={"revision": before["timeline_revision"],
        "layers": [{"index": 2, "start": 0.25, "duration": 1}]})
    assert response.status_code == 409
    after = client.get("/api/projects/video").json()
    assert after["plan"] == before["plan"] and not after["can_undo"]


def test_exact_output_duration_keeps_fractional_end_edits_valid(layer_api):
    from sqlmodel import Session
    from app.models import Project

    client, engine, _ = layer_api
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.duration = 8
        p.plan = {"operations": [{"type": "speed", "factor": 3}, {"type": "text", "text": "Title", "start": 0, "duration": 1}]}
        session.add(p)
        session.commit()
    timeline = client.get("/api/projects/video/timeline").json()
    assert timeline["output_duration"] == 2.667
    assert timeline["exact_output_duration"] == pytest.approx(8 / 3)
    response = client.patch("/api/projects/video/timeline/layers", json={"revision": timeline["revision"],
        "layers": [{"index": 1, "start": round(timeline["exact_output_duration"] - 0.1, 6), "duration": 0.1}]})
    assert response.status_code == 200, response.text


def test_pcm_peaks_keep_absolute_amplitude_and_negative_full_scale(tmp_path):
    pcm = tmp_path / "samples.pcm"
    pcm.write_bytes(struct.pack("<4h", 0, 32767, -32768, 16384))
    assert pcm_peaks(pcm, 4 / 8000, bins=4) == [0, 0.999969, 1, 0.5]


def test_real_waveform_silence_signal_cache_and_source_change(tmp_path, monkeypatch):
    from app import waveform as module

    audio = tmp_path / "audio.wav"
    cache = tmp_path / "cache"
    run_ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=1", "-af", "adelay=1000", "-c:a", "pcm_s16le", str(audio)])
    first = source_waveform(audio, cache, 2, True)
    assert len(first["peaks"]) == BINS and first["has_audio"]
    assert max(first["peaks"][:500]) < 0.001 and min(first["peaks"][600:]) > 0.05
    real = module.run_ffmpeg
    monkeypatch.setattr(module, "run_ffmpeg", lambda *_args, **_kwargs: pytest.fail("Cache must avoid FFmpeg"))
    assert source_waveform(audio, cache, 2, True) == first
    assert source_waveform(audio, cache, 2, False)["peaks"] == []
    monkeypatch.setattr(module, "run_ffmpeg", real)
    audio.write_bytes(audio.read_bytes() + b"\x00\x00")
    assert source_waveform(audio, cache, 2, True)["revision"] != first["revision"]
    assert not list(cache.glob("pcm_*")) and not list(cache.glob("*.tmp"))


def test_waveform_concurrent_requests_share_extraction_and_clean_failures(tmp_path, monkeypatch):
    from app import waveform as module

    source = tmp_path / "source.wav"
    source.write_bytes(b"test")
    calls = []
    def extract(args, **kwargs):
        calls.append(kwargs["timeout"])
        from pathlib import Path
        Path(args[-1]).write_bytes(struct.pack("<h", 1000) * 8000)
    monkeypatch.setattr(module, "run_ffmpeg", extract)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: source_waveform(source, tmp_path / "cache", 1, True), range(2)))
    assert results[0] == results[1] and calls == [120]
    def fail(args, **kwargs):
        from pathlib import Path
        Path(args[-1]).write_bytes(b"partial")
        raise RuntimeError("failed")
    monkeypatch.setattr(module, "run_ffmpeg", fail)
    with pytest.raises(RuntimeError):
        source_waveform(source, tmp_path / "failure", 1, True)
    assert not list((tmp_path / "failure").iterdir())
    def changed(args, **kwargs):
        from pathlib import Path
        Path(args[-1]).write_bytes(struct.pack("<h", 1000) * 8000)
        source.write_bytes(b"different source")
    monkeypatch.setattr(module, "run_ffmpeg", changed)
    with pytest.raises(SourceChangedError):
        source_waveform(source, tmp_path / "changed", 1, True)
    assert not list((tmp_path / "changed").iterdir())


def test_waveform_api_silent_missing_and_source_change(isolated_api, tmp_path, monkeypatch):
    from app import main

    client, _, _ = isolated_api
    assert client.get("/api/projects/video/waveform").status_code == 404
    (tmp_path / "silent.mp4").write_bytes(b"placeholder; metadata says no audio")
    response = client.get("/api/projects/silent/waveform")
    assert response.status_code == 200 and response.json()["peaks"] == []
    def changed(*_):
        raise SourceChangedError("changed")
    monkeypatch.setattr(main, "source_waveform", changed)
    assert client.get("/api/projects/video/waveform").status_code == 409


def test_real_moved_overlay_plays_from_its_beginning_and_fades_on_output_clock(layer_api, tmp_path, monkeypatch):
    from sqlmodel import Session
    from app import jobs
    from app.models import Project

    client, engine, _ = layer_api
    monkeypatch.setattr(jobs, "engine", engine)
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    monkeypatch.setattr(jobs.assets, "fonts_dir", lambda: fonts)
    source, overlay = tmp_path / "source.mp4", tmp_path / "overlay.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "color=green:size=160x90:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-c:a", "aac", str(source)])
    run_ffmpeg(["-f", "lavfi", "-i", "color=red:size=160x90:rate=30:duration=1", "-f", "lavfi", "-i", "color=blue:size=160x90:rate=30:duration=1",
                "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", str(overlay)])
    monkeypatch.setattr(jobs.assets, "resolve_overlay", lambda *_: overlay)
    with Session(engine) as session:
        p = session.get(Project, "video")
        p.duration, p.width, p.height = 6, 160, 90
        p.plan = {"operations": [{"type": "trim", "start": 1, "end": 5},
            {"type": "text", "text": "Hello", "start": 0, "duration": 1, "animation": "none"},
            {"type": "overlay", "track": "test", "start": 0, "duration": 2, "mode": "fullscreen", "animation": "fade"}]}
        session.add(p)
        session.commit()
    p = client.get("/api/projects/video").json()
    response = client.patch("/api/projects/video/timeline/layers", json={"revision": p["timeline_revision"], "layers": [
        {"index": 1, "start": 0.2, "duration": 0.5}, {"index": 2, "start": 1.5, "duration": 2},
    ]})
    assert response.status_code == 200, response.text
    result = jobs.task_render(lambda *_: None, "video")
    output = tmp_path / result["output"].split("/projects/video/")[1]
    assert probe(output).duration == pytest.approx(4, abs=0.15)
    frames = []
    for index, at in enumerate([0.4, 1.1, 1.8, 2.8, 3.8]):
        raw = tmp_path / f"frame_{index}.rgb"
        run_ffmpeg(["-ss", str(at), "-i", str(output), "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", str(raw)])
        frames.append(raw.read_bytes())
    assert sum(frames[0][i] > 180 and frames[0][i + 1] > 180 for i in range(0, len(frames[0]), 3)) > 5
    averages = [[sum(frame[channel::3]) / (len(frame) / 3) for channel in range(3)] for frame in frames]
    assert averages[1][1] > 90 and averages[1][0] < 30  # No title before B-roll.
    assert averages[2][0] > 180 and averages[2][2] < 30  # Overlay's FIRST second is red.
    assert averages[3][2] > 180 and averages[3][0] < 30  # Its second second is blue.
    assert averages[4][1] > 90 and averages[4][2] < 30  # Ends at 3.5, not the source clock.
