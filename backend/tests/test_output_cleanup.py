"""Safety checks for guarded removal of old publishing output folders."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from app.output_cleanup import (
    MIN_AGE_SECONDS, OutputCleanupBody, cleanup_outputs, referenced_tokens, scan_outputs,
)


def _age(path: Path, seconds: float) -> None:
    timestamp = time.time() - seconds
    os.utime(path, (timestamp, timestamp))


def _output(root: Path, token: str, *, age: float = 7200, files: tuple[tuple[str, int], ...] = (
    ("out.mp4", 100), ("cover.jpg", 100),
)) -> Path:
    folder = root / "outputs" / token
    folder.mkdir(parents=True)
    for name, size in files:
        (folder / name).write_bytes(b"x" * size)
    _age(folder, age)
    return folder


def _media(project: str, token: str, name: str = "out.mp4") -> str:
    return f"/media/projects/{project}/outputs/{token}/{name}"


def test_referenced_tokens_read_nested_results_and_scope_absolute_urls():
    first, second, third = "a" * 32, "b" * 32, "c" * 32
    values = [
        None, {"archive": _media("p1", first, "all.zip")},
        [{"output": _media("p1", second)}, {"thumbnail": _media("p2", third)}],
        _media("p1", third),
    ]
    assert referenced_tokens("p1", values) == {first, second, third}
    assert referenced_tokens("p2", values) == {third}
    assert referenced_tokens("p1", [f"outputs/{first}/clip.mp4"]) == {first}


def test_scan_protects_referenced_recent_and_nested_folders(tmp_path):
    referenced, eligible, recent, nested = "a" * 32, "b" * 32, "c" * 32, "d" * 32
    _output(tmp_path, referenced)
    eligible_dir = _output(tmp_path, eligible)
    _output(tmp_path, recent, age=0)
    nested_dir = tmp_path / "outputs" / nested
    (nested_dir / "inner").mkdir(parents=True)
    (nested_dir / "inner" / "out.mp4").write_bytes(b"x")
    _age(nested_dir, 7200)
    (tmp_path / "outputs" / "previews").mkdir()
    (tmp_path / "outputs" / "clipcut_20260101.mp4").write_bytes(b"render")

    found, protected = scan_outputs(tmp_path, {referenced}, now=time.time())
    assert [item["token"] for item in found] == [eligible]
    assert found[0]["bytes"] == 200 and found[0]["files"] == 2
    assert found[0]["age_seconds"] >= MIN_AGE_SECONDS
    reasons = {item["token"]: item["reason"] for item in protected}
    assert reasons == {referenced: "referenced", recent: "recent", nested: "nested"}
    assert eligible_dir.exists() and nested_dir.exists()


def test_scan_rejects_symlinked_output_folder_without_following(tmp_path):
    external = tmp_path / "external"
    external.mkdir()
    (external / "secret.txt").write_bytes(b"keep")
    token = "e" * 32
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    try:
        (outputs / token).symlink_to(external, target_is_directory=True)
    except OSError:
        pytest.skip("Bu ortamda klasör sembolik bağlantısı oluşturulamıyor.")

    found, protected = scan_outputs(tmp_path, set())
    assert found == []
    assert [(item["token"], item["reason"]) for item in protected] == [(token, "symlink")]
    result = cleanup_outputs(tmp_path, set(), [token])
    assert result["deleted"] == [] and result["skipped"] == [token]
    assert (external / "secret.txt").read_bytes() == b"keep"


def test_cleanup_deletes_only_requested_eligible_folders(tmp_path):
    referenced, eligible, recent = "a" * 32, "b" * 32, "c" * 32
    _output(tmp_path, referenced)
    eligible_dir = _output(tmp_path, eligible)
    recent_dir = _output(tmp_path, recent, age=0)
    (tmp_path / "source.mp4").write_bytes(b"source")
    (tmp_path / "thumbnail.jpg").write_bytes(b"cover")
    (tmp_path / "outputs" / "previews").mkdir()

    result = cleanup_outputs(tmp_path, {referenced}, [eligible, recent, referenced, "f" * 32],
                             now=time.time())
    assert [item["token"] for item in result["deleted"]] == [eligible]
    assert result["freed_bytes"] == 200
    assert result["failed"] == []
    assert result["skipped"] == [recent, referenced, "f" * 32]
    assert not eligible_dir.exists()
    assert recent_dir.exists() and (tmp_path / "outputs" / referenced).exists()
    assert (tmp_path / "source.mp4").read_bytes() == b"source"
    assert (tmp_path / "thumbnail.jpg").read_bytes() == b"cover"
    assert (tmp_path / "outputs" / "previews").is_dir()


def test_cleanup_body_accepts_only_unique_tokens():
    token = "a" * 32
    assert OutputCleanupBody(tokens=[token]).tokens == [token]
    for values in ([], [token, token], ["../" + token], [token.upper()], ["a" * 31]):
        with pytest.raises(ValueError):
            OutputCleanupBody(tokens=values)


@pytest.fixture
def storage_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlmodel import SQLModel, Session, create_engine
    from app import main
    from app.models import Project, get_session

    engine = create_engine(f"sqlite:///{tmp_path / 'storage.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)

    def session_provider():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[get_session] = session_provider
    monkeypatch.setattr(main.jobs, "project_dir", lambda _: tmp_path)
    with Session(engine) as session:
        session.add(Project(id="store", name="Storage", source_file="source.mp4", duration=90, status="ready"))
        session.commit()
    client = TestClient(main.app)
    try:
        yield client, engine, tmp_path
    finally:
        client.close()
        main.app.dependency_overrides.clear()
        engine.dispose()


def _job(engine, *, kind: str = "clip_render", status: str = "done", result=None):
    from sqlmodel import Session
    from app.models import Job

    with Session(engine) as session:
        job = Job(project_id="store", kind=kind, status=status, result=result)
        session.add(job)
        session.commit()
        return job.id


def test_output_api_lists_and_deletes_only_requested_unprotected_folder(storage_api):
    client, engine, root = storage_api
    referenced, eligible, recent = "a" * 32, "b" * 32, "c" * 32
    _output(root, referenced)
    eligible_dir = _output(root, eligible)
    recent_dir = _output(root, recent, age=0)
    (root / "source.mp4").write_bytes(b"source")
    (root / "thumbnail.jpg").write_bytes(b"cover")
    previews = root / "outputs" / "previews"
    previews.mkdir()
    (previews / "preview.mp4").write_bytes(b"preview")
    main_render = root / "outputs" / "clipcut_20260101_120000_abcdef12.mp4"
    main_render.write_bytes(b"main")
    _job(engine, result={"outputs": [{"output": _media("store", referenced)}]})

    response = client.get("/api/projects/store/outputs")
    assert response.status_code == 200
    data = response.json()
    assert [item["token"] for item in data["eligible"]] == [eligible]
    assert data["eligible_bytes"] == 200
    reasons = {item["token"]: item["reason"] for item in data["protected"]}
    assert reasons == {referenced: "referenced", recent: "recent"}
    assert data["min_age_seconds"] == MIN_AGE_SECONDS and data["busy"] is False

    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible]})
    assert response.status_code == 200
    result = response.json()
    assert [item["token"] for item in result["deleted"]] == [eligible]
    assert result["freed_bytes"] == 200
    assert result["failed"] == [] and result["skipped"] == []
    assert not eligible_dir.exists()
    assert (root / "outputs" / referenced).is_dir() and recent_dir.is_dir()
    assert (root / "source.mp4").read_bytes() == b"source"
    assert (root / "thumbnail.jpg").read_bytes() == b"cover"
    assert (previews / "preview.mp4").read_bytes() == b"preview"
    assert main_render.read_bytes() == b"main"


def test_output_api_scans_all_jobs_not_just_recent_list(storage_api):
    client, engine, root = storage_api
    referenced = "a" * 32
    _output(root, referenced)
    _job(engine, result={"archive": _media("store", referenced, "clipcut_exports.zip")})
    for _ in range(25):
        _job(engine, result={"outputs": []})

    data = client.get("/api/projects/store/outputs").json()
    assert data["eligible"] == []
    assert [(item["token"], item["reason"]) for item in data["protected"]] == [(referenced, "referenced")]
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": [referenced]}).status_code == 409
    assert (root / "outputs" / referenced).is_dir()


def test_output_api_refuses_while_publishing_is_active(storage_api):
    client, engine, root = storage_api
    eligible = "a" * 32
    _output(root, eligible)
    _job(engine, kind="clip_render", status="running", result=None)

    data = client.get("/api/projects/store/outputs").json()
    assert data["busy"] is True
    assert [item["token"] for item in data["eligible"]] == [eligible]
    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible]})
    assert response.status_code == 409
    assert (root / "outputs" / eligible).is_dir()


def test_output_api_rechecks_references_created_after_scan(storage_api):
    client, engine, root = storage_api
    eligible = "a" * 32
    _output(root, eligible)
    assert [item["token"] for item in client.get("/api/projects/store/outputs").json()["eligible"]] == [eligible]
    _job(engine, result={"archive": _media("store", eligible, "clipcut_exports.zip")})

    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible]})
    assert response.status_code == 409
    assert (root / "outputs" / eligible).is_dir()


def test_output_api_validation_and_missing_project(storage_api):
    client, engine, root = storage_api
    eligible = "a" * 32
    _output(root, eligible)
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": []}).status_code == 422
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible, eligible]}).status_code == 422
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": ["../../etc"]}).status_code == 422
    assert client.get("/api/projects/missing/outputs").status_code == 404
    assert client.post("/api/projects/missing/outputs/cleanup", json={"tokens": [eligible]}).status_code == 404


def test_output_api_partial_success_reports_skipped_tokens(storage_api):
    client, engine, root = storage_api
    eligible, recent = "a" * 32, "b" * 32
    _output(root, eligible)
    _output(root, recent, age=0)
    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible, recent]})
    assert response.status_code == 200
    data = response.json()
    assert [item["token"] for item in data["deleted"]] == [eligible]
    assert data["skipped"] == [recent]
