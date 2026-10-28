"""Storyboards: consent, edit isolation, cached retries and local media assembly."""
from __future__ import annotations

import copy
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

os.environ.setdefault("MOCK_AI", "true")

from app.storyboard import (  # noqa: E402
    StoryboardCreateBody, StoryboardInput, StoryboardSaveBody, fingerprint, merge_saved_spec, scene_file,
)
from app import jobs as _jobs_module  # noqa: E402

_REAL_SUBMIT = _jobs_module.submit


@pytest.fixture
def studio(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlmodel import SQLModel, Session, create_engine
    from app import config, jobs, main, models, storyboard, storyboard_jobs
    from app.ai import services, storyboard as planner

    settings = config.Settings(storage_dir=tmp_path / "store", assets_dir=config.ROOT_DIR / "assets", mock_ai="true", _env_file=None)
    settings.storage_dir.mkdir()
    engine = create_engine(f"sqlite:///{tmp_path / 'studio.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(jobs, "engine", engine)
    monkeypatch.setattr(models, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    for module in (config, jobs, storyboard, storyboard_jobs, services, planner):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    # Failing closed: these tests must never reach an external text/video API.
    monkeypatch.setattr(planner, "_client", lambda: pytest.fail("Unexpected real planning call"))
    monkeypatch.setattr(services, "_client", lambda: pytest.fail("Unexpected real video call"))

    def provide_session():
        with Session(engine) as session:
            yield session
    main.app.dependency_overrides[models.get_session] = provide_session
    captures = []
    def submit(pid, kind, fn, *args, **kwargs):
        captures.append((pid, kind, fn, args))
        return models.Job(project_id=pid, kind=kind)
    monkeypatch.setattr(jobs, "submit", submit)
    client = TestClient(main.app)
    try:
        yield client, settings, engine, captures
    finally:
        client.close()
        main.app.dependency_overrides.clear()
        engine.dispose()


def create(client, **values):
    response = client.post("/api/projects/storyboard", json={
        "brief": "Kahve hazırlığı. Taze çekirdekleri öğütün. Sıcak su ile yavaşça demleyin.",
        "scene_count": 2, "scene_duration": 4, "aspect_ratio": "16:9", **values,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_plan_is_saved_before_any_video_call(studio):
    client, _, _, captures = studio
    p = create(client)
    assert p["status"] == "draft" and p["source_url"] is None
    assert p["origin"] == "storyboard" and p["storyboard"]["mock_plan"]
    assert len(p["storyboard"]["scenes"]) == 2
    assert p["storyboard"]["planned_duration"] == 8
    assert captures == []
    assert client.get(f"/api/projects/{p['id']}").json()["storyboard"]["revision"] == p["storyboard"]["revision"]


def test_schema_rejects_invalid_durations_voice_and_duplicate_ids(studio):
    client, _, _, _ = studio
    p = create(client)
    data = p["storyboard"]
    bad = copy.deepcopy(data)
    bad["scenes"][1]["id"] = bad["scenes"][0]["id"]
    with pytest.raises(ValidationError):
        StoryboardInput.model_validate(bad)
    with pytest.raises(ValidationError):
        StoryboardInput.model_validate({**data, "voice_id": "unknown"})
    with pytest.raises(ValidationError):
        StoryboardInput.model_validate({**data, "voice_id": "en-US-JennyNeural"})
    assert client.post("/api/projects/storyboard", json={"brief": "test", "scene_count": 100}).status_code == 422
    assert client.post("/api/projects/storyboard", json={"brief": "test", "scene_duration": 5}).status_code == 422


def test_real_api_calls_require_explicit_consent(studio):
    client, settings, _, captures = studio
    p = create(client)
    settings.mock_ai = "false"
    settings.veo_model = "test-video-model"  # Fake worker is captured, never called.
    assert client.post("/api/projects/storyboard", json={"brief": "A video"}).status_code == 422
    payload = {"revision": p["storyboard"]["revision"]}
    assert client.post(f"/api/projects/{p['id']}/storyboard/generate", json=payload).status_code == 422
    assert captures == []
    payload["confirm_api_usage"] = True
    assert client.post(f"/api/projects/{p['id']}/storyboard/generate", json=payload).status_code == 200
    assert len(captures) == 1
    # Double submission cannot create another paid job.
    assert client.post(f"/api/projects/{p['id']}/storyboard/generate", json=payload).status_code == 409
    assert len(captures) == 1
    assert client.put(f"/api/projects/{p['id']}/storyboard", json=p["storyboard"]).status_code == 409


def test_legacy_veo_duration_fails_before_provider_call(studio, tmp_path):
    from app.ai import services

    client, settings, _, captures = studio
    p = create(client)
    settings.mock_ai = "false"
    settings.veo_model = "veo-3.0-fast-generate-001"
    assert client.post("/api/projects/storyboard", json={"brief": "A story", "scene_duration": 4, "confirm_api_usage": True}).status_code == 422
    response = client.post(f"/api/projects/{p['id']}/storyboard/generate", json={"revision": p["storyboard"]["revision"], "confirm_api_usage": True})
    assert response.status_code == 422 and captures == []
    with pytest.raises(services.AIError, match="8 saniye"):
        services.generate_video("test", "16:9", 4, None, tmp_path / "unused.mp4", lambda *_: None)


def test_video_request_passes_scene_duration_to_sdk(studio, tmp_path, monkeypatch):
    from types import SimpleNamespace
    from app.ai import services

    _, settings, _, _ = studio
    settings.mock_ai = "false"
    settings.veo_model = "test-model"
    received = []
    class Video:
        def save(self, path):
            Path(path).write_bytes(b"mock-provider-result")
    def generate_videos(**kwargs):
        received.append(kwargs)
        return SimpleNamespace(done=True, error=None, response=SimpleNamespace(generated_videos=[SimpleNamespace(video=Video())]))
    client = SimpleNamespace(models=SimpleNamespace(generate_videos=generate_videos), files=SimpleNamespace(download=lambda **_: None))
    monkeypatch.setattr(services, "_client", lambda: client)
    services.generate_video("test", "9:16", 6, None, tmp_path / "generated.mp4", lambda *_: None)
    assert received[0]["config"].duration_seconds == 6
    assert received[0]["config"].aspect_ratio == "9:16"


def test_edit_cache_is_server_owned_and_reorder_does_not_invalidate(studio):
    from app import jobs
    from app.storyboard import visual_fingerprint

    client, settings, _, _ = studio
    p = create(client)
    project = jobs._load(p["id"])
    spec = project.storyboard
    for scene in spec["scenes"]:
        rel = f"storyboard/scenes/{scene['id']}/cached.mp4"
        file = settings.storage_dir / "projects" / p["id"] / rel
        file.parent.mkdir(parents=True)
        file.write_bytes(b"cached")
        scene.update({"status": "ready", "file": rel, "raw_file": rel, "fingerprint": fingerprint(spec, scene),
                      "raw_fingerprint": visual_fingerprint(spec, scene)})
    edited = {**copy.deepcopy(spec), "scenes": list(reversed(copy.deepcopy(spec["scenes"])))}
    merged = merge_saved_spec(spec, StoryboardSaveBody.model_validate(edited))
    assert all(s["status"] == "ready" for s in merged["scenes"])
    edited["scenes"][0]["narration"] = "Yeni anlatım metni"
    edited["scenes"][0]["file"] = "../../outside.mp4"  # Client cannot supply trusted runtime fields.
    merged = merge_saved_spec(spec, StoryboardSaveBody.model_validate(edited))
    assert merged["scenes"][0]["status"] == "pending"
    assert "file" not in merged["scenes"][0]
    assert merged["scenes"][0]["raw_file"] != "../../outside.mp4"
    assert merged["scenes"][1]["status"] == "ready"
    assert scene_file(p["id"], "../../outside.mp4") is None
    edited["style"] = "A new visual style"
    merged = merge_saved_spec(spec, StoryboardSaveBody.model_validate(edited))
    assert all(s["status"] == "pending" and "raw_file" not in s for s in merged["scenes"])


def test_revision_check_and_source_replacement_consent(studio):
    from app import jobs

    client, _, _, _ = studio
    p = create(client)
    old = copy.deepcopy(p["storyboard"])
    changed = {**old, "title": "Updated title"}
    response = client.put(f"/api/projects/{p['id']}/storyboard", json=changed)
    assert response.status_code == 200
    current = response.json()["storyboard"]
    assert current["revision"] != old["revision"]
    assert client.put(f"/api/projects/{p['id']}/storyboard", json=old).status_code == 409
    jobs._save_project(p["id"], lambda project: setattr(project, "source_file", "old.mp4"))
    payload = {"revision": current["revision"]}
    assert client.post(f"/api/projects/{p['id']}/storyboard/generate", json=payload).status_code == 422
    assert client.post(f"/api/projects/{p['id']}/storyboard/generate", json={**payload, "scene_id": "abcdef123456", "confirm_replace_source": True}).status_code == 422


def test_mock_voiceover_does_not_contact_edge_tts(studio, tmp_path, monkeypatch):
    from app.ai import tts

    async def forbidden(*args, **kwargs):
        pytest.fail("Mock narration must never call Edge TTS")
    monkeypatch.setattr(tts, "_edge_tts_generate", forbidden)
    result = tts.generate_voiceover("Demo anlatım metni.", out_path=tmp_path / "voice.mp3", allow_fallback=False)
    assert result["mock"] is True and result["words"]


def test_real_voiceover_fails_instead_of_synthetic_fallback(studio, tmp_path, monkeypatch):
    from app.ai import tts

    async def unavailable(*args, **kwargs):
        raise RuntimeError("service unavailable")
    monkeypatch.setattr(tts, "_edge_tts_generate", unavailable)
    with pytest.raises(RuntimeError, match="sentetik test tonu"):
        tts.generate_voiceover("Real narration", out_path=tmp_path / "voice.mp3", mock_mode=False, allow_fallback=False)
    assert not (tmp_path / "voice.mp3").exists()


def test_failure_checkpoint_reuses_ready_scenes_and_raw_video(studio, monkeypatch):
    from app import jobs, storyboard_jobs as worker

    client, _, _, _ = studio
    p = create(client)
    # Skip network and heavy codecs here; real FFmpeg assembly is covered below.
    calls = []
    def generate(prompt, aspect, duration, negative, dst, progress):
        calls.append(str(dst))
        dst.write_bytes(b"raw")
    monkeypatch.setattr(worker.ai, "generate_video", generate)
    from app.ffmpeg import MediaInfo
    monkeypatch.setattr(worker, "probe", lambda path: MediaInfo(4, 160, 90, 30, True, True))
    normalized = []
    fail = True
    def normalize(raw, dst, *args):
        normalized.append(str(dst))
        if len(normalized) == 2 and fail:
            raise RuntimeError("normalize failed")
        dst.write_bytes(b"ready")
        return 4
    monkeypatch.setattr(worker, "normalize_scene", normalize)
    def fake_assemble(files, dst, *args):
        dst.write_bytes(b"assembled")
        return [4.0 * i for i in range(len(files))]
    monkeypatch.setattr(worker, "assemble_scenes", fake_assemble)
    monkeypatch.setattr(jobs, "ingest_source", lambda project, path, **kwargs: (
        setattr(project, "source_file", path.relative_to(jobs.project_dir(project.id)).as_posix()), setattr(project, "status", "ready")))
    with pytest.raises(RuntimeError, match="normalize failed"):
        worker.task_generate_storyboard(lambda *_: None, p["id"])
    state = jobs._load(p["id"])
    assert state.storyboard["scenes"][0]["status"] == "ready"
    assert state.storyboard["scenes"][1]["status"] == "failed"
    assert len(calls) == 2
    fail = False
    result = worker.task_generate_storyboard(lambda *_: None, p["id"])
    assert result["assembled"] and len(calls) == 2  # No duplicate video generation.


def test_local_multiscene_video_and_shifted_subtitles(studio, monkeypatch):
    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import probe, run_ffmpeg

    client, _, _, _ = studio
    p = create(client)
    # Real local video/audio generation, normalization and concat, no external API.
    calls = []
    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        calls.append(prompt)
        color = "red" if len(calls) == 1 else "blue"
        run_ffmpeg(["-f", "lavfi", "-i", f"color=c={color}:size=160x90:rate=10", "-t", str(duration), "-c:v", "libx264", str(path)])
    monkeypatch.setattr(worker.ai, "generate_video", local_generate)
    result = worker.task_generate_storyboard(lambda *_: None, p["id"])
    current = jobs._load(p["id"])
    info = probe(jobs.project_dir(p["id"]) / current.source_file)
    assert result["assembled"] and len(calls) == 2
    assert info.duration == pytest.approx(8, abs=0.3)
    assert (info.width, info.height) == (1280, 720) and info.has_audio
    assert current.status == "ready" and current.subtitles["mock"]
    assert current.plan["operations"][0]["type"] == "subtitles"
    assert current.subtitles["segments"][-1]["start"] >= 4
    assert all(s["status"] == "ready" for s in current.storyboard["scenes"])
    first_source = current.source_file
    result = worker.task_generate_storyboard(lambda *_: None, p["id"])
    assert result["assembled"] and len(calls) == 2  # Assembly-only creates no video calls.
    current = jobs._load(p["id"])
    assert current.source_file != first_source
    assert current.storyboard["previous_versions"][0]["source_file"] == first_source
    assert (jobs.project_dir(p["id"]) / first_source).is_file()


def test_additive_migration_keeps_existing_projects(tmp_path, monkeypatch):
    from sqlalchemy import inspect, text
    from sqlmodel import create_engine
    from app import models

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    # Create the complete current schema minus the new column, then migrate it.
    models.SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE project DROP COLUMN storyboard"))
        conn.execute(text("INSERT INTO project (id, name, status, origin, duration, width, height, has_audio, plan, plan_history, chat, created_at, updated_at) "
                          "VALUES ('legacy', 'Keep me', 'ready', 'upload', 8, 100, 100, 0, '{}', '[]', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"))
    monkeypatch.setattr(models, "engine", engine)
    models.init_db()
    models.init_db()  # Idempotent startup.
    assert "storyboard" in {c["name"] for c in inspect(engine).get_columns("project")}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT name FROM project WHERE id='legacy'")).scalar() == "Keep me"
    engine.dispose()


def test_trim_schema_and_ready_source_bounds(studio):
    from app import jobs
    from app.storyboard import SceneInput

    client, _, _, _ = studio
    p = create(client)
    scene = p["storyboard"]["scenes"][0]
    for values in ({"trim_start": float("nan")}, {"trim_end": float("inf")}, {"trim_start": -1},
                   {"trim_start": 2, "trim_end": 2.1}, {"trim_end": 31}):
        with pytest.raises(ValidationError):
            SceneInput.model_validate({**scene, **values})
    body = copy.deepcopy(p["storyboard"])
    body["scenes"][0]["trim_start"] = 1
    assert client.put(f"/api/projects/{p['id']}/storyboard", json=body).status_code == 422  # Not yet generated.
    assert jobs._load(p["id"]).storyboard["revision"] == body["revision"]


def test_trim_does_not_invalidate_media_and_rejects_forged_duration(studio):
    from app import jobs

    client, settings, _, _ = studio
    p = create(client)
    project = jobs._load(p["id"])
    spec = copy.deepcopy(project.storyboard)
    for scene in spec["scenes"]:
        rel = f"storyboard/scenes/{scene['id']}/scene.mp4"
        file = settings.storage_dir / "projects" / p["id"] / rel
        file.parent.mkdir(parents=True)
        file.write_bytes(b"cached")
        scene.update(status="ready", file=rel, actual_duration=4.0, fingerprint=fingerprint(spec, scene))
    jobs._save_project(p["id"], lambda proj: setattr(proj, "storyboard", spec))
    body = client.get(f"/api/projects/{p['id']}").json()["storyboard"]
    original_key = spec["scenes"][0]["fingerprint"]
    body["scenes"][0].update(trim_start=1, trim_end=3)
    response = client.put(f"/api/projects/{p['id']}/storyboard", json=body)
    assert response.status_code == 200
    updated = response.json()["storyboard"]
    assert updated["pending_scenes"] == 0
    assert updated["timeline_duration"] == 6
    assert updated["scenes"][0]["timeline_duration"] == 2
    assert jobs._load(p["id"]).storyboard["scenes"][0]["fingerprint"] == original_key
    invalid = copy.deepcopy(updated)
    invalid["scenes"][0].update(trim_end=6, actual_duration=100)
    assert client.put(f"/api/projects/{p['id']}/storyboard", json=invalid).status_code == 422
    invalid = copy.deepcopy(updated)
    invalid["scenes"][0]["visual_prompt"] += " changed prompt"
    assert client.put(f"/api/projects/{p['id']}/storyboard", json=invalid).status_code == 422


def test_trimmed_caption_words_are_clipped_and_shifted():
    from app.storyboard import trim_transcript_segments

    tr = {"segments": [{"start": 0, "end": 4, "text": "one two three", "words": [
        {"text": "one", "start": 0, "end": 1}, {"text": "two", "start": 1, "end": 2},
        {"text": "three", "start": 2, "end": 4},
    ]}]}
    result = trim_transcript_segments(tr, 1.5, 3, 10)
    assert result[0]["text"] == "two three"
    assert result[0]["start"] == 10 and result[0]["end"] == 11.5
    assert result[0]["words"][0]["end"] == 10.5
    assert trim_transcript_segments(tr, 5, 6, 0) == []
    # Segments cached without word timings are split proportionally before clipping.
    plain = {"segments": [{"start": 0, "end": 4, "text": "alpha beta"}]}
    derived = trim_transcript_segments(plain, 1, 3, 2)
    assert derived and derived[0]["start"] == 2 and derived[0]["end"] == 4
    assert derived[0]["words"][0]["text"] == "alpha"


def test_transition_schema_and_save_keep_media(studio):
    from app import jobs
    from app.storyboard import SceneInput, transition_overlap

    client, settings, _, _ = studio
    p = create(client)
    scene = p["storyboard"]["scenes"][0]
    for values in ({"transition": "wipe"}, {"transition_duration": 0.1}, {"transition_duration": 2.1},
                   {"transition_duration": float("nan")}):
        with pytest.raises(ValidationError):
            SceneInput.model_validate({**scene, **values})
    assert transition_overlap(4, 4, {"transition": "dissolve", "transition_duration": 0.6}) == 0.6
    assert transition_overlap(4, 4, {"transition": "fade", "transition_duration": 2}) == 1.6
    assert transition_overlap(0.4, 4, {"transition": "dissolve", "transition_duration": 2}) == 0
    assert transition_overlap(4, 4, {"transition": "cut", "transition_duration": 2}) == 0

    project = jobs._load(p["id"])
    spec = copy.deepcopy(project.storyboard)
    for item in spec["scenes"]:
        rel = f"storyboard/scenes/{item['id']}/scene.mp4"
        file = settings.storage_dir / "projects" / p["id"] / rel
        file.parent.mkdir(parents=True)
        file.write_bytes(b"cached")
        item.update(status="ready", file=rel, actual_duration=4.0, fingerprint=fingerprint(spec, item))
    jobs._save_project(p["id"], lambda proj: setattr(proj, "storyboard", spec))
    body = client.get(f"/api/projects/{p['id']}").json()["storyboard"]
    original = [item["fingerprint"] for item in spec["scenes"]]
    body["scenes"][0].update(transition="dissolve", transition_duration=1.0)  # No incoming edge.
    body["scenes"][1].update(transition="dissolve", transition_duration=1.0)
    response = client.put(f"/api/projects/{p['id']}/storyboard", json=body)
    assert response.status_code == 200
    updated = response.json()["storyboard"]
    assert updated["scenes"][0]["transition"] == "cut"
    assert updated["scenes"][1]["transition"] == "dissolve"
    assert updated["timeline_duration"] == 7 and updated["pending_scenes"] == 0
    assert [item["fingerprint"] for item in jobs._load(p["id"]).storyboard["scenes"]] == original


def test_dissolve_and_fade_assembly_keep_audio_and_subtitle_sync(studio, monkeypatch):
    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import ffmpeg_exe, probe, run_ffmpeg
    import subprocess

    client, _, _, _ = studio
    p = create(client)
    calls = []

    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        calls.append(prompt)
        color = "red" if len(calls) == 1 else "blue"
        run_ffmpeg(["-f", "lavfi", "-i", f"color=c={color}:size=160x90:rate=10", "-t", str(duration),
                    "-c:v", "libx264", str(path)])

    monkeypatch.setattr(worker.ai, "generate_video", local_generate)
    assert worker.task_generate_storyboard(lambda *_: None, p["id"])["assembled"]
    before = jobs._load(p["id"])
    first_transcript = copy.deepcopy(before.storyboard["scenes"][1]["transcript"])
    local_segment = first_transcript["segments"][0]

    def merge(kind: str) -> Path:
        body = client.get(f"/api/projects/{p['id']}").json()["storyboard"]
        body["scenes"][1].update(transition=kind, transition_duration=0.5)
        assert client.put(f"/api/projects/{p['id']}/storyboard", json=body).status_code == 200
        assert worker.task_generate_storyboard(lambda *_: None, p["id"])["assembled"]
        project = jobs._load(p["id"])
        return jobs.project_dir(p["id"]) / project.source_file

    def frame_rgb(path: Path, at: float) -> bytes:
        return subprocess.run([ffmpeg_exe(), "-v", "error", "-ss", f"{at:.3f}", "-i", str(path), "-frames:v", "1",
                               "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
                              capture_output=True, check=True).stdout

    dissolve = merge("dissolve")
    info = probe(dissolve)
    assert info.duration == pytest.approx(7.5, abs=0.15) and info.has_audio
    project = jobs._load(p["id"])
    match = next(seg for seg in project.subtitles["segments"] if seg["text"] == local_segment["text"])
    assert match["start"] == pytest.approx(3.5 + local_segment["start"], abs=0.06)
    rgb = frame_rgb(dissolve, 1.0)
    assert rgb[0] > rgb[2]  # First scene.
    rgb = frame_rgb(dissolve, 4.3)
    assert rgb[2] > rgb[0]  # Second scene after the overlap.
    assert all(w["end"] <= 7.5 + 0.06 for seg in project.subtitles["segments"] for w in seg["words"])

    fade = merge("fade")
    project = jobs._load(p["id"])
    assert probe(fade).duration == pytest.approx(7.5, abs=0.15) and project.subtitles
    assert sum(frame_rgb(fade, 3.75)) < 90  # fadeblack midpoint.
    assert len(calls) == 2  # Transition changes re-assemble locally, never call the video API.


def test_thumbnail_caches_frame_and_rejects_unknown_scene(studio, monkeypatch):
    from app import jobs, main

    client, settings, _, _ = studio
    p = create(client)
    spec = jobs._load(p["id"]).storyboard
    scene = spec["scenes"][0]
    rel = f"storyboard/scenes/{scene['id']}/scene.mp4"
    file = settings.storage_dir / "projects" / p["id"] / rel
    file.parent.mkdir(parents=True)
    file.write_bytes(b"video")
    scene.update(status="ready", file=rel, actual_duration=4, fingerprint=fingerprint(spec, scene))
    jobs._save_project(p["id"], lambda proj: setattr(proj, "storyboard", spec))
    calls = []
    def thumbnail(src, dst, at):
        calls.append(src)
        dst.write_bytes(b"JPEG")
    monkeypatch.setattr(main, "make_thumbnail", thumbnail)
    url = f"/api/projects/{p['id']}/storyboard/scenes/{scene['id']}/thumbnail"
    assert client.get(url).content == b"JPEG"
    assert client.get(url).status_code == 200 and len(calls) == 1
    assert client.get(f"/api/projects/{p['id']}/storyboard/scenes/unknown/thumbnail").status_code == 404


def test_real_trim_and_reorder_preserve_scenes_and_audio(studio, monkeypatch):
    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import probe, run_ffmpeg

    client, _, _, captures = studio
    p = create(client)
    calls = []
    def generate(prompt, aspect, duration, negative, path, callback):
        calls.append(prompt)
        run_ffmpeg(["-f", "lavfi", "-i", f"color=c={'red' if len(calls) == 1 else 'blue'}:size=160x90:rate=10",
                    "-t", str(duration), "-c:v", "libx264", str(path)])
    monkeypatch.setattr(worker.ai, "generate_video", generate)
    worker.task_generate_storyboard(lambda *_: None, p["id"])
    current = client.get(f"/api/projects/{p['id']}").json()
    draft = current["storyboard"]
    first_id = draft["scenes"][0]["id"]
    draft["scenes"] = list(reversed(draft["scenes"]))
    draft["scenes"][0].update(trim_start=1, trim_end=3)
    saved = client.put(f"/api/projects/{p['id']}/storyboard", json=draft)
    assert saved.status_code == 200 and saved.json()["storyboard"]["pending_scenes"] == 0
    originals = [s["video_url"] for s in saved.json()["storyboard"]["scenes"]]
    # Local assembly requires replacement approval, not another paid generation approval.
    revision = saved.json()["storyboard"]["revision"]
    response = client.post(f"/api/projects/{p['id']}/storyboard/generate", json={"revision": revision, "confirm_replace_source": True})
    assert response.status_code == 200
    result = worker.task_generate_storyboard(lambda *_: None, p["id"])
    final = jobs._load(p["id"])
    assert len(calls) == 2 and result["assembled"]
    assert final.storyboard["scenes"][1]["id"] == first_id
    assert [s["file"] for s in final.storyboard["scenes"]] == [url.split(f"/media/projects/{p['id']}/")[1] for url in originals]
    source = jobs.project_dir(p["id"]) / final.source_file
    info = probe(source)
    assert info.duration == pytest.approx(6.04, abs=0.15) and info.has_audio
    # First output frame must come from the reordered blue scene, not old red scene.
    import subprocess
    from app.ffmpeg import ffmpeg_exe
    rgb = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", str(source), "-frames:v", "1", "-vf", "scale=1:1",
                          "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], capture_output=True, check=True).stdout
    assert rgb[2] > rgb[0]
    assert all(0 <= w["start"] < w["end"] <= info.duration + 0.05 for seg in final.subtitles["segments"] for w in seg["words"])
    assert len(captures) == 1


def test_cancel_endpoint_only_stops_live_generate_jobs(studio):
    import threading
    from sqlmodel import Session

    from app import jobs
    from app.models import Job

    client, _, engine, _ = studio

    def make(kind: str, status: str) -> Job:
        job = Job(project_id="p", kind=kind, status=status)
        with Session(engine) as s:
            s.add(job)
            s.commit()
            s.refresh(job)
        return job

    live = make("storyboard_generate", "running")
    event = threading.Event()
    with jobs._cancel_lock:
        jobs._cancels[live.id] = event
    response = client.post(f"/api/jobs/{live.id}/cancel")
    assert response.status_code == 200
    assert response.json()["message"] == "Durdurma istendi; sürmekte olan adım bitirilir"
    assert event.is_set()
    with jobs._cancel_lock:
        jobs._cancels.pop(live.id, None)  # Registry cleanup mirrors _run's finally block.
    assert client.post(f"/api/jobs/{make('storyboard_generate', 'done').id}/cancel").status_code == 409
    assert client.post(f"/api/jobs/{make('render', 'running').id}/cancel").status_code == 409
    assert client.post("/api/jobs/missing123/cancel").status_code == 404


def test_cancellable_submit_passes_the_event_and_cleans_up(studio):
    import threading
    import time
    from sqlmodel import Session

    from app import jobs
    from app.models import Job, Project

    client, _, engine, _ = studio
    with Session(engine) as s:
        s.add(Project(id="cancel-wiring", name="Cancellation test"))
        s.commit()

    def task(progress, cancel):
        assert isinstance(cancel, threading.Event)
        cancel.set()  # The worker honours the request exactly like the scene loop would.
        return {"stopped": True}

    job = _REAL_SUBMIT("cancel-wiring", "storyboard_generate", task, cancellable=True)
    row = None
    for _ in range(600):
        with Session(engine) as s:
            row = s.get(Job, job.id)
        if row and row.status in ("done", "failed"):
            break
        time.sleep(0.01)
    assert row.status == "done" and row.result == {"stopped": True}
    with jobs._cancel_lock:
        assert jobs._cancels.get(job.id) is None


def test_stop_skips_remaining_scenes_and_resume_completes(studio, monkeypatch):
    import threading

    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import probe, run_ffmpeg

    client, _, _, _ = studio
    p = create(client)
    calls = []
    cancel = threading.Event()

    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        calls.append(prompt)
        color = "red" if len(calls) == 1 else "blue"
        run_ffmpeg(["-f", "lavfi", "-i", f"color=c={color}:size=160x90:rate=10", "-t", str(duration),
                    "-c:v", "libx264", str(path)])
        if len(calls) == 1:
            cancel.set()  # Stop request arrives while the first scene finishes.

    monkeypatch.setattr(worker.ai, "generate_video", local_generate)
    result = worker.task_generate_storyboard(lambda *_: None, p["id"], None, cancel)
    state = jobs._load(p["id"])
    assert result["stopped"] is True and result["remaining"] == 1 and not result["assembled"]
    assert len(calls) == 1  # The in-flight scene finished; scene 2 was never started or paid for.
    assert state.storyboard["scenes"][0]["status"] == "ready"
    assert state.storyboard["scenes"][1]["status"] == "pending"
    assert state.status == "draft" and state.source_file is None and state.subtitles is None
    assert client.get(f"/api/projects/{p['id']}").json()["storyboard"]["last_error"] is None  # Stop is not a failure.

    result = worker.task_generate_storyboard(lambda *_: None, p["id"])
    final = jobs._load(p["id"])
    assert result["assembled"] and len(calls) == 2  # Resume regenerates only the leftover scene.
    info = probe(jobs.project_dir(p["id"]) / final.source_file)
    assert info.duration == pytest.approx(8, abs=0.3) and info.has_audio
    assert final.storyboard["assembled_revision"] == final.storyboard["revision"]
    assert final.subtitles is not None


def test_stop_before_first_scene_generates_nothing(studio, monkeypatch):
    import threading

    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import run_ffmpeg

    client, _, _, _ = studio
    p = create(client)
    calls = []

    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=160x90:rate=10", "-t", str(duration),
                    "-c:v", "libx264", str(path)])
        calls.append(prompt)

    monkeypatch.setattr(worker.ai, "generate_video", local_generate)
    cancel = threading.Event()
    cancel.set()
    result = worker.task_generate_storyboard(lambda *_: None, p["id"], None, cancel)
    assert result["stopped"] is True and result["remaining"] == 2
    assert calls == [] and jobs._load(p["id"]).status == "draft"


def test_restore_reverts_source_editor_state_and_scope_loss(studio, monkeypatch):
    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import probe, run_ffmpeg
    from app.edit.schema import EditPlan, SubtitlesOp

    client, _, _, _ = studio
    p = create(client)

    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=160x90:rate=10", "-t", str(duration),
                    "-c:v", "libx264", str(path)])

    monkeypatch.setattr(worker.ai, "generate_video", local_generate)
    v1_job = worker.task_generate_storyboard(lambda *_: None, p["id"])
    assert v1_job["assembled"]
    v1 = client.get(f"/api/projects/{p['id']}").json()
    assert v1["storyboard"]["previous_versions"] == []
    first_rel = jobs._load(p["id"]).source_file

    # Version 2: different plan fingerprint, different editor state.
    body = copy.deepcopy(v1["storyboard"])
    body["scenes"][0]["title"] = "Yeni başlık"
    body["scenes"][0]["narration"] = body["scenes"][0]["narration"] + " ek"
    saved = client.put(f"/api/projects/{p['id']}/storyboard", json=body)
    assert saved.status_code == 200, saved.text
    # Editor state the second assembly will replace and archive.
    jobs._save_project(p["id"], lambda proj: setattr(proj, "output_file", "renders/v1_render.mp4"))
    jobs._save_project(p["id"], lambda proj: setattr(proj, "plan", EditPlan(operations=[SubtitlesOp(duration=7)]).model_dump()))
    assert worker.task_generate_storyboard(lambda *_: None, p["id"])["assembled"]

    state = client.get(f"/api/projects/{p['id']}").json()
    versions = state["storyboard"]["previous_versions"]
    assert len(versions) == 1 and versions[0]["index"] == 0 and versions[0]["restorable"] is True
    # Consent and validation guards.
    assert client.post(f"/api/projects/{p['id']}/storyboard/restore", json={"version_index": 0, "confirm": False}).status_code == 422
    assert client.post(f"/api/projects/{p['id']}/storyboard/restore", json={"version_index": 9, "confirm": True}).status_code == 404

    response = client.post(f"/api/projects/{p['id']}/storyboard/restore", json={"version_index": 0, "confirm": True})
    assert response.status_code == 200, response.text
    r = response.json()
    assert r["status"] == "ready"
    assert r["source_url"].endswith(first_rel)
    story = r["storyboard"]
    assert story["revision"] == v1["storyboard"]["revision"] and story["assembled_revision"] == story["revision"]
    assert [s["title"] for s in story["scenes"]] == [s["title"] for s in v1["storyboard"]["scenes"]]
    assert [s["narration"] for s in story["scenes"]] == [s["narration"] for s in v1["storyboard"]["scenes"]]
    assert story["previous_versions"][0]["restorable"] is True  # pre-restore state is protected and reversible

    back = jobs._load(p["id"])
    assert back.source_file.endswith(first_rel)
    assert back.plan == EditPlan(operations=[SubtitlesOp(duration=7)]).model_dump()  # editor state came back too
    assert back.output_file == "renders/v1_render.mp4"
    assert back.storyboard["source_spec"] == {k: v for k, v in back.storyboard.items() if k not in ("previous_versions", "source_spec")}
    info = probe(jobs.project_dir(p["id"]) / back.source_file)
    assert info.duration == pytest.approx(8, abs=0.3) and info.has_audio
    # After restore the newer version can come back the same way (the pre-restore state is index 0 now).
    again = client.post(f"/api/projects/{p['id']}/storyboard/restore", json={"version_index": 0, "confirm": True})
    assert again.status_code == 200
    assert jobs._load(p["id"]).plan == EditPlan(operations=[SubtitlesOp()]).model_dump()
    assert jobs._load(p["id"]).output_file is None
    assert [s["title"] for s in jobs._load(p["id"]).storyboard["scenes"]][0] == "Yeni başlık"


def test_legacy_version_without_spec_refuses_restore(studio, monkeypatch):
    from app import jobs, storyboard_jobs as worker
    from app.ffmpeg import run_ffmpeg

    client, _, _, _ = studio
    p = create(client)

    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=160x90:rate=10", "-t", str(duration),
                    "-c:v", "libx264", str(path)])

    monkeypatch.setattr(worker.ai, "generate_video", local_generate)
    assert worker.task_generate_storyboard(lambda *_: None, p["id"])["assembled"]
    def legacy(proj):
        spec = copy.deepcopy(proj.storyboard)
        spec["previous_versions"] = [{"created_at": "2026-01-01T00:00:00+00:00",
                                      "source_file": "storyboard/assemblies/legacy/source.mp4"}]
        proj.storyboard = spec
    jobs._save_project(p["id"], legacy)
    rel = jobs._load(p["id"]).source_file
    public = client.get(f"/api/projects/{p['id']}").json()["storyboard"]["previous_versions"][0]
    assert public["restorable"] is False
    response = client.post(f"/api/projects/{p['id']}/storyboard/restore", json={"version_index": 0, "confirm": True})
    assert response.status_code == 422
    assert jobs._load(p["id"]).source_file.endswith(rel)  # Nothing changed.


def test_restore_blocked_while_job_runs(studio):
    from app import jobs

    client, _, _, _ = studio
    p = create(client)
    jobs._save_project(p["id"], lambda proj: setattr(proj, "status", "generating"))
    response = client.post(f"/api/projects/{p['id']}/storyboard/restore", json={"version_index": 0, "confirm": True})
    assert response.status_code == 409


def test_duplicate_active_job_is_rejected_by_submit(studio):
    import threading
    import time
    from sqlmodel import Session as SqlSession

    from app import jobs
    from app.models import Job, Project

    client, _, engine, _ = studio
    with SqlSession(engine) as s:
        s.add(Project(id="dup-test", name="Duplicate test"))
        s.commit()
    release = threading.Event()

    def slow_task(progress):
        release.wait(5)
        return {"ok": True}

    def fast_task(progress):
        return {"ran": True}

    job = _REAL_SUBMIT("dup-test", "transcribe", slow_task)
    try:
        with pytest.raises(jobs.DuplicateJobError):
            _REAL_SUBMIT("dup-test", "transcribe", slow_task)
        # Different kinds remain independent.
        competing = _REAL_SUBMIT("dup-test", "render", fast_task)
        row = None
        for _ in range(500):
            with SqlSession(engine) as s:
                row = s.get(Job, competing.id)
            if row and row.status in ("done", "failed"):
                break
            time.sleep(0.01)
        assert row.status == "done"
    finally:
        release.set()
        for _ in range(500):
            with SqlSession(engine) as s:
                row = s.get(Job, job.id)
            if row and row.status in ("done", "failed"):
                break
            time.sleep(0.01)
    assert row.status == "done"
    # After the first run finishes, the same kind is allowed again.
    again = _REAL_SUBMIT("dup-test", "transcribe", fast_task)
    for _ in range(500):
        with SqlSession(engine) as s:
            row = s.get(Job, again.id)
        if row and row.status in ("done", "failed"):
            break
        time.sleep(0.01)
    assert row.status == "done"


def test_duplicate_job_submission_returns_http_409(studio, monkeypatch):
    from app import jobs

    client, _, _, _ = studio
    p = create(client)
    jobs._save_project(p["id"], lambda proj: setattr(proj, "status", "ready"))

    def boom(*args, **kwargs):
        raise jobs.DuplicateJobError("Bu proje için 'transcribe' işlemi zaten sırada veya sürüyor; bitmesini bekleyin.")

    monkeypatch.setattr(jobs, "submit", boom)
    response = client.post(f"/api/projects/{p['id']}/transcribe", json={"target_language": "en"})
    assert response.status_code == 409
    assert "zaten sırada veya sürüyor" in response.text


def test_project_list_reports_storyboard_progress_and_subtitles(studio, monkeypatch):
    from app import storyboard_jobs as worker
    from app.ffmpeg import run_ffmpeg

    client, _, _, _ = studio
    p = create(client)

    def local_generate(prompt, aspect, duration, negative, path, on_progress):
        run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=160x90:rate=10", "-t", str(duration),
                    "-c:v", "libx264", str(path)])

    monkeypatch.setattr(worker.ai, "generate_video", local_generate)

    def listing():
        return [q for q in client.get("/api/projects").json() if q["id"] == p["id"]][0]

    row = listing()
    assert row["storyboard_progress"] == {"ready": 0, "total": 2, "assembled": False}
    assert row["has_subtitles"] is False
    assert worker.task_generate_storyboard(lambda *_: None, p["id"])["assembled"]
    row = listing()
    assert row["storyboard_progress"] == {"ready": 2, "total": 2, "assembled": True}
    assert row["has_subtitles"] is True
    # The dashboard download shortcuts are backed by real endpoints.
    assert client.get(f"/api/projects/{p['id']}/subtitles.srt").status_code == 200
    assert "-->" in client.get(f"/api/projects/{p['id']}/subtitles.srt").text


def test_model_catalog_and_preflight_are_local(studio):
    client, settings, _, captures = studio
    catalog = client.get("/api/ai/models")
    assert catalog.status_code == 200
    data = catalog.json()
    assert data["defaults"]["video_model"] == settings.veo_model
    assert data["defaults"]["text_model"] == settings.gemini_text_model
    assert {model["id"] for model in data["video"]} >= {settings.veo_model}
    assert data["pricing_read_at"] and data["pricing_note"]

    estimate = client.post("/api/ai/preflight", json={
        "video_model": settings.veo_model, "text_model": settings.gemini_text_model,
        "scene_durations": [4, 6], "voiceover": True, "planning_scene_count": 2, "planning_chars": 200,
    })
    assert estimate.status_code == 200, estimate.text
    body = estimate.json()
    assert body["mock"] is True and body["priced"] is True
    assert body["estimated_usd"] == 0.0
    assert body["video_seconds"] == 10 and body["video_calls"] == 2 and body["tts_calls"] == 2
    assert captures == []


def test_real_preflight_estimates_and_unknown_models_are_rejected(studio):
    client, settings, _, captures = studio
    settings.mock_ai = "false"
    response = client.post("/api/ai/preflight", json={
        "video_model": "veo-3.0-fast-generate-001", "scene_durations": [8], "voiceover": False,
    })
    assert response.status_code == 200, response.text
    estimate = response.json()
    assert estimate["estimated_usd"] == pytest.approx(1.2)
    assert estimate["pricing_read_at"] == "2026-10-22"

    assert client.post("/api/ai/preflight", json={"video_model": "not-a-real-model"}).status_code == 422
    assert client.post("/api/projects/storyboard", json={"brief": "A brief", "video_model": "not-a-real-model"}).status_code == 422
    assert client.post("/api/projects/generate", json={"prompt": "test", "video_model": "not-a-real-model"}).status_code == 422
    assert captures == []


def test_budget_blocks_generation_before_job(studio):
    client, settings, _, captures = studio
    p = create(client, scene_duration=8)
    settings.mock_ai = "false"
    payload = {"revision": p["storyboard"]["revision"], "confirm_api_usage": True, "max_cost_usd": 0.01}
    response = client.post(f"/api/projects/{p['id']}/storyboard/generate", json=payload)
    assert response.status_code == 422
    assert "bütçesini aşıyor" in response.text
    assert captures == []


def test_budget_rejects_unpriced_model(studio):
    client, settings, _, captures = studio
    settings.veo_model = "test-video-model"
    settings.veo_model_options = "test-video-model"
    p = create(client, scene_duration=4, video_model="test-video-model")
    settings.mock_ai = "false"
    response = client.post(f"/api/projects/{p['id']}/storyboard/generate", json={
        "revision": p["storyboard"]["revision"], "confirm_api_usage": True, "max_cost_usd": 100,
    })
    assert response.status_code == 422
    assert "fiyatı bilinmediği" in response.text
    assert captures == []


def test_single_scene_budget_blocks_before_job(studio):
    client, settings, _, captures = studio
    settings.mock_ai = "false"
    response = client.post("/api/projects/generate", json={
        "prompt": "A short video", "duration": 8, "video_model": "veo-3.0-fast-generate-001", "max_cost_usd": 0,
    })
    assert response.status_code == 422
    assert "bütçesini aşıyor" in response.text
    assert captures == []


def test_single_scene_real_generation_requires_explicit_confirmation_before_job(studio):
    client, settings, _, captures = studio
    settings.mock_ai = "false"
    body = {"prompt": "A short video", "duration": 8}
    response = client.post("/api/projects/generate", json=body)
    assert response.status_code == 422 and "onay" in response.text
    assert captures == []
    assert client.post("/api/projects/generate", json={**body, "confirm_api_usage": True}).status_code == 200
    assert len(captures) == 1


def test_storyboard_preflight_is_server_authoritative_and_never_creates_jobs(studio):
    client, _, _, captures = studio
    p = create(client)
    revision = p["storyboard"]["revision"]
    endpoint = f"/api/projects/{p['id']}/storyboard/preflight"
    response = client.post(endpoint, json={"revision": revision})
    assert response.status_code == 200 and response.json()["video_calls"] == 2
    scene = p["storyboard"]["scenes"][0]
    response = client.post(endpoint, json={"revision": revision, "scene_id": scene["id"]})
    assert response.status_code == 200 and response.json()["video_calls"] == 1
    assert client.get(f"/api/projects/{p['id']}").json() == p
    assert captures == []
    assert client.post(endpoint, json={"revision": "0" * 12}).status_code == 409
    assert client.post(endpoint, json={"revision": revision, "scene_id": "foreign"}).status_code == 422


def test_explicit_models_are_saved_and_fingerprint_changes(studio):
    client, _, _, _ = studio
    p = create(client, scene_duration=4, text_model="gemini-2.5-pro", video_model="veo-3.0-generate-001")
    story = p["storyboard"]
    assert story["text_model"] == "gemini-2.5-pro"
    assert story["video_model"] == "veo-3.0-generate-001"
    spec = copy.deepcopy(story)
    first = fingerprint(spec, spec["scenes"][0])
    spec["video_model"] = "veo-3.0-fast-generate-001"
    assert fingerprint(spec, spec["scenes"][0]) != first
