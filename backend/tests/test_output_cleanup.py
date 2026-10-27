"""Safety checks for guarded storage cleanup, trash restore and main renders."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from app.output_cleanup import (
    MIN_AGE_SECONDS, TRASH_RETENTION_SECONDS, OutputCleanupBody, RenderCleanupBody,
    TrashEmptyBody, TrashRestoreBody, empty_trash, purge_all_expired_trash, purge_expired_trash,
    render_references, referenced_tokens, restore_trash, scan_outputs, scan_renders, scan_storage,
    scan_trash, trash_outputs, trash_renders,
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


def _render(root: Path, name: str, *, size: int = 100, age: float = 7200) -> Path:
    path = root / "outputs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    _age(path, age)
    return path


def _render_name(hex_part: str) -> str:
    return f"clipcut_20260101_120000_{hex_part}.mp4"


def _render_media(project: str, name: str) -> str:
    return f"/media/projects/{project}/outputs/{name}"


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


def test_render_references_scope_absolute_urls_and_read_nested_values():
    first, second, third = "a" * 32, "b" * 32, "c" * 32
    names = {key: f"clipcut_{key}.mp4" for key in (first, second, third)}
    values = [
        None,
        {"output_file": f"outputs/{names[first]}"},
        [{"archive": _render_media("p1", names[second])}],
        _render_media("p1", names[third]),
    ]
    assert render_references("p1", values) == {
        f"outputs/{names[first]}", f"outputs/{names[second]}", f"outputs/{names[third]}",
    }
    assert render_references("p2", [_render_media("p2", names[third]),
                                    _render_media("p1", names[second])]) == {f"outputs/{names[third]}"}


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
    result = trash_outputs(tmp_path, set(), [token])
    assert result["trashed"] == [] and result["skipped"] == [token]
    assert (external / "secret.txt").read_bytes() == b"keep"


def test_scan_storage_groups_regular_files_and_keeps_total_consistent(tmp_path):
    (tmp_path / "source.mp4").write_bytes(b"x" * 10)
    (tmp_path / "thumb.jpg").write_bytes(b"x" * 2)
    (tmp_path / "voiceover.mp3").write_bytes(b"x" * 3)
    (tmp_path / "mock_title.ass").write_bytes(b"x")
    render = tmp_path / "outputs" / "clipcut_20260101_120000_abcdef12.mp4"
    render.parent.mkdir()
    render.write_bytes(b"x" * 100)
    staging = tmp_path / "outputs" / ("a" * 32) / "out.mp4"
    staging.parent.mkdir()
    staging.write_bytes(b"x" * 50)
    for directory, size in (("previews", 20), ("clip_previews", 30)):
        path = tmp_path / "outputs" / directory / "preview.mp4"
        path.parent.mkdir()
        path.write_bytes(b"x" * size)
    work = tmp_path / "work" / "render" / "command.txt"
    work.parent.mkdir(parents=True)
    work.write_bytes(b"x" * 5)
    trashed = tmp_path / ".trash" / ("f" * 32) / "payload" / "old.mp4"
    trashed.parent.mkdir(parents=True)
    trashed.write_bytes(b"x" * 7)

    categories, total = scan_storage(tmp_path, ("source.mp4", "thumb.jpg", "voiceover.mp3"))
    by_id = {item["id"]: item for item in categories}
    assert by_id["source"] == {"id": "source", "bytes": 15, "files": 3}
    assert by_id["renders"] == {"id": "renders", "bytes": 100, "files": 1}
    assert by_id["staging"] == {"id": "staging", "bytes": 50, "files": 1}
    assert by_id["previews"] == {"id": "previews", "bytes": 50, "files": 2}
    assert by_id["work"] == {"id": "work", "bytes": 5, "files": 1}
    assert by_id["trash"] == {"id": "trash", "bytes": 7, "files": 1}
    assert by_id["other"] == {"id": "other", "bytes": 1, "files": 1}
    assert total == 228


def test_scan_storage_does_not_follow_links(tmp_path):
    (tmp_path / "source.mp4").write_bytes(b"source")
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir(exist_ok=True)
    (outside / "hidden.bin").write_bytes(b"x" * 999)
    try:
        (tmp_path / "outputs").mkdir()
        (tmp_path / "outputs" / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Bu ortamda sembolik bağlantı oluşturulamıyor.")

    categories, total = scan_storage(tmp_path, ("source.mp4",))
    assert total == 6
    assert all(item["bytes"] == 0 for item in categories if item["id"] != "source")


def test_scan_renders_protects_referenced_recent_and_reports_links(tmp_path):
    eligible = _render(tmp_path, _render_name("aaaaaaaa"))
    referenced = _render(tmp_path, _render_name("bbbbbbbb"))
    recent = _render(tmp_path, _render_name("cccccccc"), age=0)
    (tmp_path / "outputs" / "clipcut_exports.zip").write_bytes(b"zip")
    external = tmp_path / "external.mp4"
    external.write_bytes(b"elsewhere")
    linked = tmp_path / "outputs" / _render_name("dddddddd")
    try:
        linked.symlink_to(external)
    except OSError:
        linked = None

    found, protected = scan_renders(tmp_path, {f"outputs/{referenced.name}"})
    assert [item["file"] for item in found] == [eligible.name]
    reasons = {item["file"]: item["reason"] for item in protected}
    assert reasons == {referenced.name: "referenced", recent.name: "recent",
                       **(({linked.name: "symlink"}) if linked else {})}
    assert external.read_bytes() == b"elsewhere"
    result = trash_renders(tmp_path, {f"outputs/{referenced.name}"},
                           [eligible.name, referenced.name, recent.name])
    assert [item["name"] for item in result["trashed"]] == [eligible.name]
    assert result["skipped"] == [referenced.name, recent.name]
    assert not eligible.exists() and referenced.exists() and recent.exists()
    assert [item["name"] for item in scan_trash(tmp_path)["entries"]] == [eligible.name]


def test_cleanup_bodies_accept_only_unique_safe_names():
    token = "a" * 32
    render_name = _render_name("aaaaaaaa")
    assert OutputCleanupBody(tokens=[token]).tokens == [token]
    for values in ([], [token, token], ["../" + token], [token.upper()], ["a" * 31]):
        with pytest.raises(ValueError):
            OutputCleanupBody(tokens=values)
    assert RenderCleanupBody(files=[render_name]).files == [render_name]
    too_many = [f"clipcut_20260101_120000_{index:08d}.mp4" for index in range(51)]
    for values in ([], [render_name, render_name], ["../" + render_name], [render_name.upper()],
                   ["notes.mp4"], too_many):
        with pytest.raises(ValueError):
            RenderCleanupBody(files=values)


def test_trash_bodies_reject_traversal_and_unbounded_lists():
    entry = "a" * 32
    assert TrashRestoreBody(ids=[entry]).ids == [entry]
    assert TrashEmptyBody(ids=[]).ids == []
    for values in ([entry, entry], ["../" + entry], [entry.upper()]):
        with pytest.raises(ValueError):
            TrashRestoreBody(ids=values)
        with pytest.raises(ValueError):
            TrashEmptyBody(ids=values)
    with pytest.raises(ValueError):
        TrashRestoreBody(ids=[])
    with pytest.raises(ValueError):
        TrashEmptyBody(ids=[f"{index:032x}" for index in range(51)])


def test_trash_outputs_moves_folder_and_restore_returns_it(tmp_path):
    token = "b" * 32
    folder = _output(tmp_path, token)
    result = trash_outputs(tmp_path, set(), [token])
    assert [entry["name"] for entry in result["trashed"]] == [token]
    assert result["moved_bytes"] == 200
    entry = result["trashed"][0]
    assert entry["kind"] == "staging" and entry["files"] == 2
    assert not folder.exists()
    manifest = (tmp_path / ".trash" / entry["id"] / "manifest.json")
    assert json.loads(manifest.read_text(encoding="utf-8"))["status"] == "ready"
    trash = scan_trash(tmp_path)
    assert trash["bytes"] == 200 and trash["entries"][0]["id"] == entry["id"]
    assert trash["retention_seconds"] == TRASH_RETENTION_SECONDS

    restored = restore_trash(tmp_path, [entry["id"]])
    assert [item["id"] for item in restored["restored"]] == [entry["id"]]
    assert (folder / "out.mp4").read_bytes() == b"x" * 100
    assert scan_trash(tmp_path)["entries"] == []
    assert not (tmp_path / ".trash" / entry["id"]).exists()


def test_trash_renders_moves_file_and_restore_returns_it(tmp_path):
    name = _render_name("aaaaaaaa")
    path = _render(tmp_path, name, size=321)
    result = trash_renders(tmp_path, set(), [name])
    entry = result["trashed"][0]
    assert entry["kind"] == "render" and entry["bytes"] == 321 and not path.exists()
    restored = restore_trash(tmp_path, [entry["id"]])
    assert len(restored["restored"]) == 1
    assert path.read_bytes() == b"x" * 321


def test_restore_refuses_to_overwrite_and_keeps_trash(tmp_path):
    name = _render_name("bbbbbbbb")
    path = _render(tmp_path, name, size=40)
    entry = trash_renders(tmp_path, set(), [name])["trashed"][0]
    path.write_bytes(b"new-current")
    result = restore_trash(tmp_path, [entry["id"]])
    assert result["restored"] == [] and result["skipped"] == [entry["id"]]
    assert path.read_bytes() == b"new-current"
    assert [item["id"] for item in scan_trash(tmp_path)["entries"]] == [entry["id"]]


def test_purge_expired_trash_removes_only_old_entries(tmp_path):
    current = time.time()
    old_name = _render_name("aaaaaaaa")
    recent_name = _render_name("bbbbbbbb")
    _render(tmp_path, old_name, size=10, age=10 * 86400)
    _render(tmp_path, recent_name, size=20, age=10 * 86400)
    old_entry = trash_renders(tmp_path, set(), [old_name], now=current - 8 * 86400)["trashed"][0]
    recent_entry = trash_renders(tmp_path, set(), [recent_name], now=current - 86400)["trashed"][0]

    result = purge_expired_trash(tmp_path, now=current)
    assert [item["id"] for item in result["purged"]] == [old_entry["id"]]
    assert result["freed_bytes"] == 10
    assert not (tmp_path / ".trash" / old_entry["id"]).exists()
    assert (tmp_path / ".trash" / recent_entry["id"]).exists()
    assert [item["id"] for item in scan_trash(tmp_path, now=current)["entries"]] == [recent_entry["id"]]


def test_purge_all_expired_trash_sweeps_projects(tmp_path):
    current = time.time()
    projects = tmp_path / "projects"
    project = projects / "p1"
    old_name = _render_name("aaaaaaaa")
    _render(project, old_name, size=13, age=10 * 86400)
    entry = trash_renders(project, set(), [old_name], now=current - 8 * 86400)["trashed"][0]
    (projects / "note.txt").write_bytes(b"keep")

    purge_all_expired_trash(projects, now=current)
    assert not (project / ".trash" / entry["id"]).exists()
    assert (projects / "note.txt").read_bytes() == b"keep"


def test_empty_trash_can_target_one_entry_or_all(tmp_path):
    first = _render_name("aaaaaaaa")
    second = _render_name("bbbbbbbb")
    _render(tmp_path, first, size=11)
    _render(tmp_path, second, size=22)
    first_entry = trash_renders(tmp_path, set(), [first])["trashed"][0]
    second_entry = trash_renders(tmp_path, set(), [second])["trashed"][0]

    selected = empty_trash(tmp_path, [first_entry["id"]])
    assert [item["id"] for item in selected["purged"]] == [first_entry["id"]]
    assert selected["freed_bytes"] == 11
    assert [item["id"] for item in scan_trash(tmp_path)["entries"]] == [second_entry["id"]]

    all_entries = empty_trash(tmp_path, [])
    assert [item["id"] for item in all_entries["purged"]] == [second_entry["id"]]
    assert all_entries["freed_bytes"] == 22
    assert scan_trash(tmp_path)["entries"] == []


def test_pending_trash_entry_is_recovered_and_empty_pending_is_discarded(tmp_path):
    entry_id = "c" * 32
    entry_dir = tmp_path / ".trash" / entry_id
    payload = entry_dir / "payload" / _render_name("cccccccc")
    payload.parent.mkdir(parents=True)
    payload.write_bytes(b"recover")
    (entry_dir / "manifest.json").write_text(json.dumps({
        "id": entry_id, "kind": "render", "name": payload.name, "bytes": 7, "files": 1,
        "deleted_at": "2026-01-01T00:00:00+00:00", "batch_id": "d" * 32, "status": "pending",
    }), encoding="utf-8")
    entries = scan_trash(tmp_path)["entries"]
    assert [item["id"] for item in entries] == [entry_id]
    assert json.loads((entry_dir / "manifest.json").read_text(encoding="utf-8"))["status"] == "ready"

    empty_id = "e" * 32
    empty_dir = tmp_path / ".trash" / empty_id
    empty_dir.mkdir()
    (empty_dir / "manifest.json").write_text(json.dumps({
        "id": empty_id, "kind": "render", "name": _render_name("eeeeeeee"), "bytes": 0, "files": 0,
        "deleted_at": "2026-01-01T00:00:00+00:00", "batch_id": "f" * 32, "status": "pending",
    }), encoding="utf-8")
    assert [item["id"] for item in scan_trash(tmp_path)["entries"]] == [entry_id]
    assert not empty_dir.exists()


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
        session.add(Project(id="store", name="Storage", source_file="source.mp4", thumbnail_file="thumbnail.jpg",
                            duration=90, status="ready"))
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


def _set_output_file(engine, name: str) -> None:
    from sqlmodel import Session
    from app.models import Project

    with Session(engine) as session:
        project = session.get(Project, "store")
        project.output_file = f"outputs/{name}"
        session.add(project)
        session.commit()


def test_output_api_moves_old_unreferenced_renders_to_trash(storage_api):
    client, engine, root = storage_api
    (root / "source.mp4").write_bytes(b"s" * 100)
    (root / "thumbnail.jpg").write_bytes(b"c" * 20)
    work = root / "work" / "render" / "command.txt"
    work.parent.mkdir(parents=True)
    work.write_bytes(b"w" * 7)
    previews = root / "outputs" / "previews"
    previews.mkdir(parents=True)
    (previews / "preview.mp4").write_bytes(b"p" * 11)
    clip_previews = root / "outputs" / "clip_previews"
    clip_previews.mkdir()
    (clip_previews / "clip.mp4").write_bytes(b"c" * 12)
    current = _render(root, _render_name("11111111"), size=40)
    eligible = _render(root, _render_name("22222222"), size=30)
    consumer = _render(root, _render_name("33333333"), size=20)
    recent = _render(root, _render_name("44444444"), size=10, age=0)
    own_render = _render(root, _render_name("55555555"), size=5)
    _set_output_file(engine, current.name)
    _job(engine, kind="export_batch", result={"note": _render_media("store", consumer.name)})
    _job(engine, kind="render", result={"output": _render_media("store", own_render.name)})

    data = client.get("/api/projects/store/outputs").json()
    assert [item["file"] for item in data["renders"]["eligible"]] == [eligible.name, own_render.name]
    assert data["renders"]["eligible_bytes"] == 35
    assert {item["file"]: item["reason"] for item in data["renders"]["protected"]} == {
        current.name: "referenced", consumer.name: "referenced", recent.name: "recent",
    }
    assert data["trash"]["entries"] == [] and data["render_busy"] is False
    assert data["reclaimable_bytes"] == 35
    categories = {item["id"]: item for item in data["categories"]}
    assert categories["source"]["bytes"] == 120
    assert categories["renders"]["bytes"] == 105
    assert categories["previews"]["bytes"] == 23
    assert categories["work"]["bytes"] == 7
    assert data["total_bytes"] == sum(item["bytes"] for item in data["categories"])

    response = client.post("/api/projects/store/outputs/renders/cleanup",
                           json={"files": [eligible.name, own_render.name]})
    assert response.status_code == 200
    result = response.json()
    assert [item["name"] for item in result["trashed"]] == [eligible.name, own_render.name]
    assert result["moved_bytes"] == 35
    assert not eligible.exists() and not own_render.exists()
    assert current.exists() and consumer.exists() and recent.exists()
    assert (root / "source.mp4").read_bytes() == b"s" * 100
    assert (root / "thumbnail.jpg").read_bytes() == b"c" * 20
    assert work.read_bytes() == b"w" * 7
    assert (previews / "preview.mp4").read_bytes() == b"p" * 11
    assert (clip_previews / "clip.mp4").read_bytes() == b"c" * 12

    after = client.get("/api/projects/store/outputs").json()
    assert after["renders"]["eligible"] == []
    assert after["trash"]["bytes"] == 35 and len(after["trash"]["entries"]) == 2
    assert {item["id"]: item for item in after["categories"]}["trash"]["bytes"] == 35
    assert after["reclaimable_bytes"] == 0
    from sqlmodel import Session
    from app.models import Project

    with Session(engine) as session:
        assert session.get(Project, "store").output_file == f"outputs/{current.name}"


def test_output_api_moves_staging_folder_and_restores_then_purges(storage_api):
    client, engine, root = storage_api
    token = "a" * 32
    folder = _output(root, token)
    (root / "source.mp4").write_bytes(b"source")
    (root / "thumbnail.jpg").write_bytes(b"cover")

    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [token]})
    assert response.status_code == 200
    moved = response.json()
    assert [item["name"] for item in moved["trashed"]] == [token]
    assert moved["moved_bytes"] == 200
    assert not folder.exists()
    entry = client.get("/api/projects/store/outputs").json()["trash"]["entries"][0]
    assert entry["kind"] == "staging" and entry["name"] == token and entry["bytes"] == 200

    response = client.post("/api/projects/store/outputs/trash/restore", json={"ids": [entry["id"]]})
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["restored"]] == [entry["id"]]
    assert (folder / "out.mp4").read_bytes() == b"x" * 100
    assert client.get("/api/projects/store/outputs").json()["trash"]["entries"] == []

    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": [token]}).status_code == 200
    entry = client.get("/api/projects/store/outputs").json()["trash"]["entries"][0]
    response = client.post("/api/projects/store/outputs/trash/empty", json={})
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["purged"]] == [entry["id"]]
    assert response.json()["freed_bytes"] == 200
    assert not folder.exists()
    assert client.get("/api/projects/store/outputs").json()["trash"]["entries"] == []
    assert (root / "source.mp4").read_bytes() == b"source"
    assert (root / "thumbnail.jpg").read_bytes() == b"cover"


def test_output_api_restore_conflict_and_empty_specific_entry(storage_api):
    client, engine, root = storage_api
    name = _render_name("aaaaaaaa")
    path = _render(root, name, size=44)
    moved = client.post("/api/projects/store/outputs/renders/cleanup", json={"files": [name]}).json()
    entry = moved["trashed"][0]
    path.write_bytes(b"new-file")

    response = client.post("/api/projects/store/outputs/trash/restore", json={"ids": [entry["id"]]})
    assert response.status_code == 409
    assert path.read_bytes() == b"new-file"
    assert [item["id"] for item in client.get("/api/projects/store/outputs").json()["trash"]["entries"]] == [entry["id"]]

    response = client.post("/api/projects/store/outputs/trash/empty", json={"ids": [entry["id"]]})
    assert response.status_code == 200
    assert response.json()["freed_bytes"] == 44
    assert client.get("/api/projects/store/outputs").json()["trash"]["entries"] == []


def test_output_api_purges_expired_trash_when_scanned(storage_api):
    client, engine, root = storage_api
    current = time.time()
    name = _render_name("aaaaaaaa")
    _render(root, name, size=9, age=10 * 86400)
    entry = trash_renders(root, set(), [name], now=current - 8 * 86400)["trashed"][0]

    data = client.get("/api/projects/store/outputs").json()
    assert data["trash"]["entries"] == []
    assert not (root / ".trash" / entry["id"]).exists()


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


def test_output_api_rechecks_staging_references_created_after_scan(storage_api):
    client, engine, root = storage_api
    eligible = "a" * 32
    _output(root, eligible)
    assert [item["token"] for item in client.get("/api/projects/store/outputs").json()["eligible"]] == [eligible]
    _job(engine, result={"archive": _media("store", eligible, "clipcut_exports.zip")})

    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible]})
    assert response.status_code == 409
    assert (root / "outputs" / eligible).is_dir()


@pytest.mark.parametrize("kind", ["render", "clip_render"])
def test_render_cleanup_refuses_while_output_writer_is_active(storage_api, kind):
    client, engine, root = storage_api
    eligible = _render(root, _render_name("aaaaaaaa"))
    _job(engine, kind=kind, status="running", result=None)

    data = client.get("/api/projects/store/outputs").json()
    assert data["render_busy"] is True
    assert [item["file"] for item in data["renders"]["eligible"]] == [eligible.name]
    response = client.post("/api/projects/store/outputs/renders/cleanup", json={"files": [eligible.name]})
    assert response.status_code == 409
    assert eligible.exists()


def test_render_cleanup_rechecks_references_created_after_scan(storage_api):
    client, engine, root = storage_api
    eligible = _render(root, _render_name("aaaaaaaa"))
    assert [item["file"] for item in client.get("/api/projects/store/outputs").json()["renders"]["eligible"]] == [eligible.name]
    _job(engine, kind="storyboard_generate", result={"source": _render_media("store", eligible.name)})

    response = client.post("/api/projects/store/outputs/renders/cleanup", json={"files": [eligible.name]})
    assert response.status_code == 409
    assert eligible.exists()


def test_output_api_validation_and_missing_project(storage_api):
    client, engine, root = storage_api
    token = "a" * 32
    name = _render_name("aaaaaaaa")
    _output(root, token)
    _render(root, name)
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": []}).status_code == 422
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": [token, token]}).status_code == 422
    assert client.post("/api/projects/store/outputs/cleanup", json={"tokens": ["../../etc"]}).status_code == 422
    assert client.post("/api/projects/store/outputs/renders/cleanup", json={"files": []}).status_code == 422
    assert client.post("/api/projects/store/outputs/renders/cleanup", json={"files": [name, name]}).status_code == 422
    assert client.post("/api/projects/store/outputs/renders/cleanup", json={"files": ["../../etc"]}).status_code == 422
    assert client.post("/api/projects/store/outputs/trash/restore", json={"ids": []}).status_code == 422
    assert client.post("/api/projects/store/outputs/trash/restore", json={"ids": [token, token]}).status_code == 422
    assert client.post("/api/projects/store/outputs/trash/restore", json={"ids": ["../../etc"]}).status_code == 422
    assert client.post("/api/projects/store/outputs/trash/empty", json={"ids": ["../../etc"]}).status_code == 422
    assert client.post("/api/projects/store/outputs/trash/empty", json={"ids": ["a" * 32]}).status_code == 409
    assert client.get("/api/projects/missing/outputs").status_code == 404
    assert client.post("/api/projects/missing/outputs/cleanup", json={"tokens": [token]}).status_code == 404
    assert client.post("/api/projects/missing/outputs/renders/cleanup", json={"files": [name]}).status_code == 404
    assert client.post("/api/projects/missing/outputs/trash/restore", json={"ids": [token]}).status_code == 404
    assert client.post("/api/projects/missing/outputs/trash/empty", json={}).status_code == 404


def test_output_api_partial_success_reports_skipped_items(storage_api):
    client, engine, root = storage_api
    eligible, recent = "a" * 32, "b" * 32
    _output(root, eligible)
    _output(root, recent, age=0)
    response = client.post("/api/projects/store/outputs/cleanup", json={"tokens": [eligible, recent]})
    assert response.status_code == 200
    data = response.json()
    assert [item["name"] for item in data["trashed"]] == [eligible]
    assert data["skipped"] == [recent]

    render = _render_name("aaaaaaaa")
    recent_render = _render_name("bbbbbbbb")
    _render(root, render)
    _render(root, recent_render, age=0)
    response = client.post("/api/projects/store/outputs/renders/cleanup",
                           json={"files": [render, recent_render]})
    assert response.status_code == 200
    data = response.json()
    assert [item["name"] for item in data["trashed"]] == [render]
    assert data["skipped"] == [recent_render]


def test_trash_is_not_served_by_media(storage_api):
    client, engine, root = storage_api
    for path in ("/media/projects/store/.trash/anything", "/media/projects/store/.TRASH/anything"):
        response = client.get(path)
        assert response.status_code == 404
        assert "Bulunamad" in response.text
