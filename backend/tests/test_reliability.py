"""Failure-path regressions using isolated SQLite and storage; no provider calls."""
from __future__ import annotations

import copy
import io
import os

os.environ.setdefault("MOCK_AI", "true")

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine, select

from app import config, jobs, main, models
from app.models import Job, Project


@pytest.fixture
def studio(tmp_path, monkeypatch):
    settings = config.Settings(storage_dir=tmp_path / "store", mock_ai="true", _env_file=None)
    settings.storage_dir.mkdir()
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(jobs, "engine", engine)
    monkeypatch.setattr(models, "engine", engine)
    monkeypatch.setattr(jobs, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "settings", settings)

    def sessions():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[models.get_session] = sessions
    client = TestClient(main.app)
    try:
        yield client, engine, settings
    finally:
        client.close()
        main.app.dependency_overrides.clear()
        engine.dispose()


@pytest.mark.parametrize("status", ["queued", "running"])
def test_delete_refuses_active_job_and_preserves_bytes(studio, status):
    client, engine, settings = studio
    with Session(engine) as s:
        p = Project(name="Keep", status="ready")
        s.add(p)
        s.commit()
        pid = p.id
        s.add(Job(project_id=pid, kind="render", status=status))
        s.commit()
    source = jobs.project_dir(pid) / "source.mp4"
    source.write_bytes(b"original media")
    assert client.delete(f"/api/projects/{pid}").status_code == 409
    assert source.read_bytes() == b"original media"
    with Session(engine) as s:
        assert s.get(Project, pid) is not None
        job = s.exec(select(Job)).one()
        assert job.status == status
        job.status = "failed"
        s.add(job)
        s.commit()
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert not source.parent.exists()
    with Session(engine) as s:
        assert s.get(Project, pid) is None
        assert not s.exec(select(Job)).all()


@pytest.mark.parametrize("kind", ["render", "generate", "storyboard_generate"])
def test_rejected_enqueue_finishes_job_clears_cancel_and_allows_retry(studio, monkeypatch, kind):
    _, engine, _ = studio
    with Session(engine) as s:
        p = Project(name="Retry", status="generating" if kind != "render" else "ready")
        s.add(p)
        s.commit()
        pid = p.id

    class Reject:
        def submit(self, *args):
            raise RuntimeError("executor unavailable")

    monkeypatch.setattr(jobs, "_executor", Reject())
    with pytest.raises(RuntimeError, match="executor unavailable"):
        jobs.submit(pid, kind, lambda *_: None, cancellable=True)
    with Session(engine) as s:
        job = s.exec(select(Job)).one()
        assert job.status == "failed" and job.finished_at is not None
        assert job.error == "executor unavailable"
        assert job.id not in jobs._cancels
        assert s.get(Project, pid).status != "generating"

    class Inline:
        def submit(self, fn, *args):
            fn(*args)

    monkeypatch.setattr(jobs, "_executor", Inline())
    retry = jobs.submit(pid, kind, lambda *_: {"ok": True})
    assert retry.status == "done" and retry.result == {"ok": True}


def test_submit_rejects_deleted_project_before_enqueue(studio, monkeypatch):
    class Unexpected:
        def submit(self, *args):
            pytest.fail("A missing project's task must not run")
    monkeypatch.setattr(jobs, "_executor", Unexpected())
    with pytest.raises(ValueError, match="Proje bulunamadı"):
        jobs.submit("missing", "render", lambda *_: None)


def test_partial_upload_disk_failure_removes_folder_and_project(studio, monkeypatch):
    client, engine, settings = studio

    def disk_full(src, dst):
        dst.write(b"partial upload")
        raise OSError("disk full")

    monkeypatch.setattr(main.shutil, "copyfileobj", disk_full)
    response = client.post("/api/projects/upload", files={"file": ("video.mp4", b"media", "video/mp4")})
    assert response.status_code == 507
    assert list((settings.storage_dir / "projects").iterdir()) == []
    with Session(engine) as s:
        assert not s.exec(select(Project)).all()


def test_invalid_upload_removes_folder_and_project(studio, monkeypatch):
    client, engine, settings = studio

    def invalid(*args):
        raise ValueError("no video stream")

    monkeypatch.setattr(jobs, "ingest_source", invalid)
    response = client.post("/api/projects/upload", files={"file": ("video.mp4", b"bad media", "video/mp4")})
    assert response.status_code == 400
    assert list((settings.storage_dir / "projects").iterdir()) == []
    with Session(engine) as s:
        assert not s.exec(select(Project)).all()


def test_upload_commit_failure_rolls_back_and_cleans_files(studio, monkeypatch):
    _, engine, settings = studio
    monkeypatch.setattr(jobs, "ingest_source", lambda *_: None)
    with Session(engine) as s:
        def fail_commit():
            raise RuntimeError("database write failed")
        monkeypatch.setattr(s, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="database write failed"):
            main.upload_project(UploadFile(filename="video.mp4", file=io.BytesIO(b"media")), "Video", s)
        assert not s.new
    assert list((settings.storage_dir / "projects").iterdir()) == []


def test_restart_recovery_is_terminal_idempotent_and_preserves_project_state(studio):
    _, engine, _ = studio
    spec = {"scenes": [{"id": "ready", "status": "ready", "file": "kept.mp4"},
                       {"id": "pending", "status": "generating", "raw_file": "raw.mp4"}]}
    with Session(engine) as s:
        p = Project(name="Recover", status="generating", origin="storyboard", source_file="source.mp4",
                    storyboard=copy.deepcopy(spec), output_file="outputs/old.mp4", plan_history=[{"operations": []}])
        s.add(p)
        s.commit()
        pid = p.id
        for status in ("queued", "running", "done", "failed"):
            s.add(Job(project_id=pid, kind="render", status=status, message=status,
                      result={"output": "keep"} if status == "done" else None))
        s.commit()
    source = jobs.project_dir(pid) / "source.mp4"
    source.write_bytes(b"keep source")
    models.init_db()
    with Session(engine) as s:
        rows = s.exec(select(Job)).all()
        recovered = [j for j in rows if j.error == "Sunucu yeniden başlatıldı."]
        assert len(recovered) == 2
        assert all(j.status == "failed" and j.finished_at is not None and "yarım kaldı" in j.message for j in recovered)
        assert next(j for j in rows if j.status == "done").result == {"output": "keep"}
        p = s.get(Project, pid)
        assert p.status == "ready" and p.output_file == "outputs/old.mp4" and p.plan_history
        assert p.storyboard["scenes"][0] == spec["scenes"][0]
        assert p.storyboard["scenes"][1]["status"] == "failed"
        assert p.storyboard["scenes"][1]["raw_file"] == "raw.mp4"
        snapshot = [j.model_dump() for j in rows]
    models.init_db()
    with Session(engine) as s:
        assert [j.model_dump() for j in s.exec(select(Job)).all()] == snapshot
    assert source.read_bytes() == b"keep source"


def test_failed_render_preserves_previous_output_and_edit_history(studio, monkeypatch):
    _, engine, _ = studio
    with Session(engine) as s:
        p = Project(name="Render retry", status="ready", duration=8, source_file="source.mp4",
                    output_file="outputs/old.mp4", output_meta={"previous": True},
                    plan_history=[{"operations": []}])
        s.add(p)
        s.commit()
        pid = p.id
        before = p.model_dump()
    root = jobs.project_dir(pid)
    (root / "outputs").mkdir()
    (root / "source.mp4").write_bytes(b"source")
    (root / "outputs/old.mp4").write_bytes(b"previous successful render")

    def fail_render(*args):
        raise RuntimeError("encoding failed")

    class Inline:
        def submit(self, fn, *args):
            fn(*args)

    monkeypatch.setattr(jobs, "render", fail_render)
    monkeypatch.setattr(jobs, "_executor", Inline())
    job = jobs.submit(pid, "render", jobs.task_render, pid)
    assert job.status == "failed" and job.finished_at is not None
    assert job.error == "encoding failed"
    with Session(engine) as s:
        assert s.get(Project, pid).model_dump() == before
    assert (root / "outputs/old.mp4").read_bytes() == b"previous successful render"
    assert (root / "source.mp4").read_bytes() == b"source"


def test_download_serves_exact_bytes_and_rejects_unsafe_or_missing_paths(studio):
    client, engine, settings = studio
    with Session(engine) as s:
        p = Project(name="Download", status="ready", thumbnail_file="thumb.jpg")
        s.add(p)
        s.commit()
        pid = p.id
    root = jobs.project_dir(pid)
    (root / "outputs").mkdir()
    (root / "outputs/clip.mp4").write_bytes(b"exact video bytes")
    (root / "thumb.jpg").write_bytes(b"cover bytes")
    (root / "source.mp4").write_bytes(b"private source")
    (root / ".trash").mkdir()
    (root / ".trash/old.mp4").write_bytes(b"trash")
    (settings.storage_dir / "outside.mp4").write_bytes(b"outside project")
    url = f"/api/projects/{pid}/download/"
    response = client.get(url + "outputs/clip.mp4")
    assert response.status_code == 200 and response.content == b"exact video bytes"
    assert "attachment" in response.headers["content-disposition"]
    assert client.get(url + "thumb.jpg").content == b"cover bytes"
    for filename in ("source.mp4", "outputs/missing.mp4", "outputs/", ".trash/old.mp4",
                     "outputs/%2e%2e/source.mp4", "outputs/%2e%2e/%2e%2e/%2e%2e/outside.mp4"):
        assert client.get(url + filename).status_code == 404, filename


def _editable_project(engine):
    with Session(engine) as s:
        p = Project(name="Concurrent edits", status="ready", source_file="source.mp4", duration=8)
        s.add(p)
        s.commit()
        return p.id


def test_full_plan_saves_reject_stale_revision_and_preserve_undo(studio):
    client, engine, _ = studio
    pid = _editable_project(engine)
    endpoint = f"/api/projects/{pid}"
    before = client.get(endpoint).json()
    plan = {"operations": [{"type": "speed", "factor": 1.25}]}
    assert client.put(endpoint + "/plan", json={"plan": plan, "revision": before["render_revision"]}).status_code == 200
    assert client.put(endpoint + "/plan", json={"plan": {"operations": []}, "revision": before["render_revision"]}).status_code == 409
    assert client.post(endpoint + "/plan/undo").json()["plan"] == before["plan"]
    assert not client.get(endpoint).json()["can_undo"]


def test_two_concurrent_full_plan_saves_accept_only_one_revision(studio):
    from concurrent.futures import ThreadPoolExecutor
    client, engine, _ = studio
    pid = _editable_project(engine)
    endpoint = f"/api/projects/{pid}"
    revision = client.get(endpoint).json()["render_revision"]

    def save(factor):
        return client.put(endpoint + "/plan", json={"revision": revision,
            "plan": {"operations": [{"type": "speed", "factor": factor}]}}).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(save, [1.25, 1.5])) == [200, 409]
    assert not client.post(endpoint + "/plan/undo").json()["can_undo"]


def test_noop_plan_save_does_not_create_undo_and_legacy_request_still_works(studio):
    client, engine, _ = studio
    pid = _editable_project(engine)
    endpoint = f"/api/projects/{pid}"
    response = client.put(endpoint + "/plan", json={"plan": {"operations": []}})
    assert response.status_code == 200 and not response.json()["can_undo"]


def test_ai_plan_cannot_overwrite_changes_saved_while_planner_runs(studio, monkeypatch):
    from app.edit.schema import EditPlan
    client, engine, _ = studio
    pid = _editable_project(engine)
    endpoint = f"/api/projects/{pid}"

    def planner(*args):
        with Session(engine) as s:
            p = s.get(Project, pid)
            p.plan = EditPlan.model_validate({"operations": [{"type": "speed", "factor": 1.5}]}).model_dump()
            s.add(p)
            s.commit()
        return EditPlan(), "stale result"

    monkeypatch.setattr(main.ai, "plan_edit", planner)
    monkeypatch.setattr(main, "_context", lambda p: {})
    response = client.post(endpoint + "/edit", json={"prompt": "edit"})
    assert response.status_code == 409
    saved = client.get(endpoint).json()
    assert saved["plan"]["operations"][0]["factor"] == 1.5
    assert saved["chat"] == []


@pytest.mark.parametrize("change", ["plan", "subtitles", "source_file", "name"])
def test_render_records_its_start_revision_without_overwriting_newer_edits(studio, monkeypatch, change):
    client, engine, _ = studio
    pid = _editable_project(engine)
    root = jobs.project_dir(pid)
    (root / "source.mp4").write_bytes(b"original source")
    before = client.get(f"/api/projects/{pid}").json()
    values = {"plan": {"operations": [{"type": "speed", "factor": 1.5}]},
              "subtitles": {"language": "tr", "segments": []},
              "source_file": "replacement.mp4", "name": "Renamed during render"}

    def local_render(req, progress):
        req.output.parent.mkdir(parents=True, exist_ok=True)
        req.output.write_bytes(b"rendered snapshot")
        with Session(engine) as s:
            p = s.get(Project, pid)
            setattr(p, change, values[change])
            s.add(p)
            s.commit()
        return {"duration": 8, "width": 160, "height": 90}

    monkeypatch.setattr(jobs, "render", local_render)
    result = jobs.task_render(lambda *_: None, pid)
    after = client.get(f"/api/projects/{pid}").json()
    assert result["render_revision"] == before["render_revision"]
    assert after["output_meta"]["render_revision"] == before["render_revision"]
    assert (after["render_revision"] == before["render_revision"]) == (change == "name")
    with Session(engine) as s:
        assert getattr(s.get(Project, pid), change) == values[change]
    assert (root / "source.mp4").read_bytes() == b"original source"
    assert client.get(f"/api/projects/{pid}/download/" + result["output"].split(f"/media/projects/{pid}/")[1]).content == b"rendered snapshot"


def test_provider_error_guidance_reaches_http_and_job_without_sdk_secrets(studio, monkeypatch, caplog):
    from google.genai.errors import ClientError
    from app.ai.provider_errors import normalize_provider_errors
    client, engine, _ = studio
    pid = _editable_project(engine)
    calls = []
    @normalize_provider_errors
    def unavailable(*args):
        calls.append(True)
        raise ClientError(403, {"error": {"message": "SECRET_KEY_AND_PROMPT"}})
    monkeypatch.setattr(main.ai, "plan_edit", unavailable)
    monkeypatch.setattr(main, "_context", lambda _: {})
    response = client.post(f"/api/projects/{pid}/edit", json={"prompt": "edit"})
    assert response.status_code == 422
    assert response.json()["code"] == "provider_permission_denied"
    assert "izin" in response.json()["hint"]
    assert "SECRET_KEY_AND_PROMPT" not in response.text
    class Inline:
        def submit(self, fn, *args):
            fn(*args)
    monkeypatch.setattr(jobs, "_executor", Inline())
    job = jobs.submit(pid, "transcribe", unavailable)
    assert job.status == "failed" and "izin" in job.error
    assert "SECRET_KEY_AND_PROMPT" not in job.error
    assert "SECRET_KEY_AND_PROMPT" not in caplog.text
    assert len(calls) == 2  # One explicit HTTP request and one explicit worker run, no retry.


def test_template_and_undo_reject_old_editor_revision(studio):
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}"
    before = client.get(url).json()
    assert client.put(url + "/plan", json={"plan": {"operations": [{"type": "speed", "factor": 1.5}]}}).status_code == 200
    template = client.get("/api/templates").json()[0]["id"]
    for endpoint in (f"/apply-template/{template}", "/plan/undo", "/voiceover", "/broll/apply-auto"):
        data = {"revision": before["edit_revision"]}
        if endpoint == "/voiceover":
            data["text"] = "Do not synthesize"
        assert client.post(url + endpoint, json=data).status_code == 409
    saved = client.get(url).json()
    assert saved["plan"]["operations"][0]["factor"] == 1.5
    assert len(saved["chat"]) == 0
    assert client.post(url + "/plan/undo", json={"revision": saved["edit_revision"]}).status_code == 200


def test_voiceover_conflict_preserves_audio_plan_subtitles_and_chat(studio, monkeypatch):
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}"
    root = jobs.project_dir(pid)
    (root / "voiceover.mp3").write_bytes(b"old voice")
    jobs._save_project(pid, lambda p: setattr(p, "voiceover_file", "voiceover.mp3"))
    before = client.get(url).json()

    def synthesize(*args, out_path, **kwargs):
        assert out_path.name != "voiceover.mp3"
        out_path.write_bytes(b"new voice")
        assert client.put(url + "/plan", json={"plan": {"operations": [{"type": "speed", "factor": 1.5}]}}).status_code == 200
        return {"language": "tr", "segments": [], "words": [], "duration": 1}

    monkeypatch.setattr(main.tts, "generate_voiceover", synthesize)
    response = client.post(url + "/voiceover", json={"text": "Hello", "revision": before["edit_revision"]})
    assert response.status_code == 409
    after = client.get(url).json()
    assert after["voiceover_url"] == before["voiceover_url"]
    assert after["subtitles"] == before["subtitles"] and after["chat"] == before["chat"]
    assert after["plan"]["operations"][0]["factor"] == 1.5
    assert (root / "voiceover.mp3").read_bytes() == b"old voice"
    assert not list(root.glob("voiceover_*.mp3"))


def test_voiceover_publication_uses_immutable_files_and_delete_keeps_old_bytes(studio, monkeypatch):
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}"
    paths = []
    def synthesize(*args, out_path, **kwargs):
        paths.append(out_path)
        out_path.write_bytes(f"voice-{len(paths)}".encode())
        return {"language": "tr", "segments": [], "words": [], "duration": 1}
    monkeypatch.setattr(main.tts, "generate_voiceover", synthesize)
    for _ in range(2):
        revision = client.get(url).json()["edit_revision"]
        assert client.post(url + "/voiceover", json={"text": "Hello", "revision": revision}).status_code == 200
    assert paths[0] != paths[1] and paths[0].read_bytes() == b"voice-1"
    saved = client.get(url).json()
    assert client.request("DELETE", url + "/voiceover", json={"revision": revision}).status_code == 409
    assert client.request("DELETE", url + "/voiceover", json={"revision": saved["edit_revision"]}).status_code == 200
    assert paths[1].read_bytes() == b"voice-2"


def test_auto_broll_cannot_overwrite_edits_during_suggestion(studio, monkeypatch):
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}"
    def suggest(*args):
        client.put(url + "/plan", json={"plan": {"operations": [{"type": "speed", "factor": 1.5}]}})
        return [{"type": "overlay", "track": "stock:forest", "start": 0, "duration": 2}]
    monkeypatch.setattr(main.broll, "suggest_broll_for_transcript", suggest)
    assert client.post(url + "/broll/apply-auto").status_code == 409
    saved = client.get(url).json()
    assert saved["plan"]["operations"][0]["factor"] == 1.5 and saved["chat"] == []


@pytest.mark.parametrize("kind", ["transcribe", "translate"])
def test_long_worker_results_do_not_replace_newer_edits(studio, monkeypatch, kind):
    client, engine, _ = studio
    pid = _editable_project(engine)
    transcript = {"language": "tr", "segments": [{"id": 0, "start": 0, "end": 1, "text": "original", "words": []}]}
    def prepare(p):
        p.has_audio = True
        p.transcript = p.subtitles = transcript
    jobs._save_project(pid, prepare)
    def provider(*args):
        jobs._save_project(pid, lambda p: setattr(p, "plan", {"operations": [{"type": "speed", "factor": 1.5}]}))
        return {"language": "en", "segments": []}
    monkeypatch.setattr(jobs, "extract_audio", lambda *_: None)
    monkeypatch.setattr(jobs.ai, "transcribe", provider)
    monkeypatch.setattr(jobs.ai, "translate", provider)
    with pytest.raises(ValueError, match="yeni düzenlemeler"):
        if kind == "transcribe":
            jobs.task_transcribe(lambda *_: None, pid, None)
        else:
            jobs.task_translate(lambda *_: None, pid, "en")
    saved = client.get(f"/api/projects/{pid}").json()
    assert saved["subtitles"] == transcript and saved["plan"]["operations"][0]["factor"] == 1.5


def test_worker_publication_and_api_plan_save_share_lock(studio):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}"
    revision = client.get(url).json()["render_revision"]
    entered, release = Event(), Event()
    def mutate(p):
        entered.set()
        assert release.wait(5)
        p.plan = {"operations": [{"type": "speed", "factor": 1.5}]}
    with ThreadPoolExecutor(max_workers=2) as pool:
        worker = pool.submit(jobs._save_project, pid, mutate)
        assert entered.wait(5)
        api_write = pool.submit(client.put, url + "/plan", json={"revision": revision, "plan": {"operations": []}})
        release.set()
        worker.result(timeout=5)
        assert api_write.result(timeout=5).status_code == 409


def test_idempotency_replays_completed_generation_without_second_project_or_job(studio, monkeypatch):
    client, engine, _ = studio
    calls = []
    class Inline:
        def submit(self, fn, *args):
            fn(*args)
    monkeypatch.setattr(jobs, "_executor", Inline())
    monkeypatch.setattr(jobs, "task_generate", lambda *args: calls.append(True) or {"ok": True})
    headers = {"Idempotency-Key": "generate-request-0001"}
    body = {"prompt": "local test generation", "duration": 8}
    first = client.post("/api/projects/generate", json=body, headers=headers)
    assert first.status_code == 200, first.text
    second = client.post("/api/projects/generate", json=body, headers=headers)
    assert second.status_code == 200 and second.json() == first.json()
    assert second.headers["Idempotency-Status"] == "replayed" and len(calls) == 1
    with Session(engine) as s:
        assert len(s.exec(select(Project)).all()) == len(s.exec(select(Job)).all()) == 1
    # A fresh client / startup recovery does not forget the completed request.
    models.init_db()
    fresh = TestClient(main.app)
    try:
        assert fresh.post("/api/projects/generate", json=body, headers=headers).json() == first.json()
    finally:
        fresh.close()
    assert len(calls) == 1


def test_idempotency_rejects_changed_payload_or_route(studio):
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}"
    headers = {"Idempotency-Key": "rename-request-00001"}
    assert client.patch(url, json={"name": "First"}, headers=headers).status_code == 200
    response = client.patch(url, json={"name": "Second"}, headers=headers)
    assert response.status_code == 409 and response.headers["Idempotency-Status"] == "conflict"
    assert client.delete(url, headers=headers).status_code == 409
    assert client.get(url).json()["name"] == "First"
    assert client.patch(url, json={"name": "Invalid"}, headers={"Idempotency-Key": "short"}).status_code == 422


def test_idempotency_concurrent_request_is_reserved_before_provider_and_stays_pending_on_restart(studio, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    client, engine, _ = studio
    pid = _editable_project(engine)
    url = f"/api/projects/{pid}/edit"
    entered, release = Event(), Event()
    calls = []
    def planner(*args):
        from app.edit.schema import EditPlan
        calls.append(True)
        entered.set()
        assert release.wait(5)
        return EditPlan(), "same"
    monkeypatch.setattr(main.ai, "plan_edit", planner)
    monkeypatch.setattr(main, "_context", lambda _: {})
    headers = {"Idempotency-Key": "concurrent-request-01"}
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, url, json={"prompt": "test"}, headers=headers)
        assert entered.wait(5)
        try:
            second = client.post(url, json={"prompt": "test"}, headers=headers)
            assert second.status_code == 409 and second.headers["Idempotency-Status"] == "pending"
        finally:
            release.set()
        assert first.result(timeout=5).status_code == 200
    assert len(calls) == 1
    # Simulate a crash after reservation (unknown outcome): init must not clear it.
    with Session(engine) as s:
        record = s.get(models.MutationRequest, headers["Idempotency-Key"])
        record.status_code = record.response_body = None
        s.add(record)
        s.commit()
    models.init_db()
    assert client.post(url, json={"prompt": "test"}, headers=headers).headers["Idempotency-Status"] == "pending"
    assert len(calls) == 1


def test_idempotency_ambiguous_provider_failure_is_never_called_twice(studio, monkeypatch):
    from app.ai.provider_errors import ProviderFailure
    client, engine, _ = studio
    pid = _editable_project(engine)
    calls = []
    def provider(*args):
        calls.append(True)
        raise ProviderFailure("provider_unavailable", "Safe uncertain failure", "Check job list", 503)
    monkeypatch.setattr(main.ai, "plan_edit", provider)
    monkeypatch.setattr(main, "_context", lambda _: {})
    headers = {"Idempotency-Key": "uncertain-request-01"}
    url = f"/api/projects/{pid}/edit"
    assert client.post(url, json={"prompt": "test"}, headers=headers).status_code == 503
    assert client.post(url, json={"prompt": "test"}, headers=headers).status_code == 409
    assert len(calls) == 1


def test_idempotency_unhandled_exception_leaves_durable_reservation(studio, monkeypatch):
    client, engine, _ = studio
    pid = _editable_project(engine)
    calls = []
    def interrupted(*args, **kwargs):
        calls.append(True)
        raise RuntimeError("interrupted after request started")
    monkeypatch.setattr(main.tts, "generate_voiceover", interrupted)
    headers = {"Idempotency-Key": "interrupted-request-01"}
    url = f"/api/projects/{pid}/voiceover"
    with pytest.raises(RuntimeError, match="interrupted"):
        client.post(url, json={"text": "Hello"}, headers=headers)
    assert client.post(url, json={"text": "Hello"}, headers=headers).status_code == 409
    assert len(calls) == 1
