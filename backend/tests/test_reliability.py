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
