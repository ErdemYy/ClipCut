"""Real HTTP/process restart regression with isolated SQLite and local FFmpeg only."""
from __future__ import annotations

import hashlib
import os
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import httpx
import pytest

from app.ffmpeg import ffmpeg_exe, probe, run_ffmpeg


def wait_until(read, accept, *, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = read()
        if accept(last):
            return last
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for restart smoke condition; last={last!r}")


class OwnedServer:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir()
        self.process = None
        self.log = None
        self.url = ""
        self.token = uuid.uuid4().hex

    def start(self):
        assert self.process is None
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            port = available.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        env = {**os.environ, "MOCK_AI": "true", "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "",
               "STORAGE_DIR": str(self.root / "storage"), "ASSETS_DIR": str(self.root / "assets"),
               "DATABASE_URL": f"sqlite:///{(self.root / 'restart.db').as_posix()}",
               "PYTHONUNBUFFERED": "1"}
        self.log = (self.root / "server.log").open("ab")
        self.process = subprocess.Popen(
            [sys.executable, "-m", "tests.restart_server", str(self.root), str(port), self.token, ffmpeg_exe()],
            cwd=Path(__file__).resolve().parents[1], env=env, stdout=self.log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        def ready():
            if self.process.poll() is not None:
                raise AssertionError((self.root / "server.log").read_text(encoding="utf-8", errors="replace"))
            try:
                response = self.request("GET", "/api/health", timeout=1)
                return response.status_code == 200 and response.headers.get("X-Restart-Test") == self.token
            except httpx.TransportError:
                return False

        wait_until(ready, bool, timeout=30)
        return self.process.pid

    def stop(self):
        # Kill only the process we created, never a port owner or an unrelated server.
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=10)
            self.process = None
        if self.log is not None:
            self.log.close()
            self.log = None

    def request(self, method, path, **kwargs):
        kwargs.setdefault("timeout", 30)
        response = httpx.request(method, self.url + path, trust_env=False, **kwargs)
        return response

    def json(self, method, path, **kwargs):
        response = self.request(method, path, **kwargs)
        assert response.status_code == 200, response.text
        return response.json()


def file_hash(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def manifest(root):
    return {path.relative_to(root).as_posix(): file_hash(path) for path in root.rglob("*") if path.is_file()}


def project_row(root, pid):
    # Read-only inspection of this test's own DB, not the configured application DB.
    with closing(sqlite3.connect((root / "restart.db").as_uri() + "?mode=ro", uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        return dict(connection.execute("SELECT * FROM project WHERE id = ?", (pid,)).fetchone())


def finished_job(server, job_id):
    job = wait_until(lambda: server.json("GET", f"/api/jobs/{job_id}"),
                     lambda value: value["status"] in ("done", "failed"), timeout=45)
    assert job["status"] == "done", job
    return job


@pytest.mark.slow
def test_forced_process_restart_preserves_edits_media_and_request_identity(tmp_path):
    source = tmp_path / "synthetic.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)], timeout=15)
    server = OwnedServer(tmp_path / "restart")
    pending = ThreadPoolExecutor(max_workers=1)
    try:
        first_pid = server.start()
        with source.open("rb") as media:
            project = server.json("POST", "/api/projects/upload", files={"file": ("synthetic.mp4", media, "video/mp4")},
                                  data={"name": "Restart isolation"})
        pid = project["id"]
        url = f"/api/projects/{pid}"
        root = server.root / "storage" / "projects" / pid
        voice = {"text": "Local sine fixture, not provider speech", "auto_subtitles": False}
        project = server.json("POST", url + "/voiceover", json=voice)["project"]
        project = server.json("PUT", url + "/plan", json={"revision": project["render_revision"],
            "plan": {"operations": [{"type": "speed", "factor": 1.25}]}})
        options = {"resolution": "720p", "quality": "fast"}
        baseline_job = finished_job(server, server.json("POST", url + "/render", json=options)["id"])
        project = server.json("GET", url)
        old_output = project["output_url"]
        assert baseline_job["result"]["render_revision"] == project["render_revision"]
        assert probe(root / "source.mp4").has_video
        assert file_hash(root / "source.mp4") == file_hash(source)
        assert project["thumbnail_url"] and project["voiceover_url"] and old_output
        assert (root / "thumb.jpg").is_file()
        active_voice = root / project["voiceover_url"].split(f"/media/projects/{pid}/")[1]
        assert probe(active_voice).has_audio

        # Complete another genuine FFmpeg encode, but block immediately before publication.
        (server.root / "hold-render").touch()
        render_key = {"Idempotency-Key": "restart-held-render-0001"}
        interrupted = server.json("POST", url + "/render", json=options, headers=render_key)
        encoded = wait_until(lambda: (server.root / "entered-render").read_text() if
                             (server.root / "entered-render").exists() else None, bool)
        assert Path(encoded).is_file() and probe(Path(encoded)).has_video
        assert server.json("GET", f"/api/jobs/{interrupted['id']}")["status"] == "running"
        assert server.json("GET", url)["output_url"] == old_output

        # Also interrupt a synchronous request after durable reservation and local audio creation.
        (server.root / "hold-tts").touch()
        voice_key = {"Idempotency-Key": "restart-held-voice-00001"}
        voice_body = {**voice, "revision": project["edit_revision"]}
        voice_future = pending.submit(server.request, "POST", url + "/voiceover", json=voice_body, headers=voice_key)
        wait_until(lambda: (server.root / "entered-tts").exists(), bool)
        assert len((server.root / "tts-calls.txt").read_text().splitlines()) == 2

        # New edits while both old results are pending must survive the abrupt shutdown.
        project = server.json("PUT", url + "/plan", json={"revision": project["render_revision"],
            "plan": {"operations": [{"type": "speed", "factor": 1.5}]}})
        project = server.json("PUT", url + "/subtitles", json={"revision": project["subtitle_revision"], "segments": [
            {"id": 0, "start": 0.1, "end": 1.8, "text": "Saved edit", "words": [
                {"text": "Saved", "start": 0.1, "end": 0.8}, {"text": "edit", "start": 0.8, "end": 1.8}]}]})
        project = server.json("PATCH", url, json={"name": "Saved during interrupted work"})
        assert project["output_meta"]["render_revision"] != project["render_revision"]
        before_row, before_files = project_row(server.root, pid), manifest(root)
        srt = server.request("GET", url + "/subtitles.srt").content
        old_bytes = server.request("GET", url + "/download/" + old_output.split(f"/media/projects/{pid}/")[1]).content
        server.stop()  # Real forced termination, no lifespan shutdown/recovery call in this interpreter.
        try:
            response = voice_future.result(timeout=5)
            assert response.status_code >= 500
        except httpx.TransportError:
            pass  # Expected: the response disappeared when its server process was killed.

        second_pid = server.start()
        assert second_pid != first_pid
        recovered = server.json("GET", f"/api/jobs/{interrupted['id']}")
        assert recovered["status"] == "failed" and recovered["finished_at"]
        assert recovered["error"] == "Sunucu yeniden başlatıldı."
        assert "yarım kaldı" in recovered["message"]
        assert server.json("GET", url) == project
        assert project_row(server.root, pid) == before_row  # Includes exact plan_history/chat/transcript JSON.
        assert manifest(root) == before_files
        assert server.request("GET", url + "/subtitles.srt").content == srt
        assert server.request("GET", url + "/download/" + old_output.split(f"/media/projects/{pid}/")[1]).content == old_bytes

        replay = server.request("POST", url + "/render", json=options, headers=render_key)
        assert replay.headers["Idempotency-Status"] == "replayed" and replay.json()["id"] == interrupted["id"]
        blocked = server.request("POST", url + "/voiceover", json=voice_body, headers=voice_key)
        assert blocked.status_code == 409 and blocked.headers["Idempotency-Status"] == "pending"
        assert len(server.json("GET", url + "/jobs")) == 2
        assert len((server.root / "tts-calls.txt").read_text().splitlines()) == 2
        assert server.json("GET", f"/api/jobs/{baseline_job['id']}") == baseline_job

        # A genuinely new explicit local render can run; the old request is never replayed as work.
        (server.root / "hold-render").unlink()
        fresh_key = {"Idempotency-Key": "restart-explicit-render-01"}
        fresh = server.json("POST", url + "/render", json=options, headers=fresh_key)
        final = finished_job(server, fresh["id"])
        assert final["result"]["render_revision"] == project["render_revision"]
        assert server.json("GET", url)["output_meta"]["render_revision"] == project["render_revision"]
        assert len(server.json("GET", url + "/jobs")) == 3
        for name, digest in before_files.items():
            assert file_hash(root / name) == digest
        assert project_row(server.root, pid)["plan_history"] == before_row["plan_history"]
        final_files = manifest(root)

        # A second real restart is idempotent for recovered failures and completed work.
        server.stop()
        server.start()
        assert server.json("GET", f"/api/jobs/{interrupted['id']}") == recovered
        assert server.json("GET", f"/api/jobs/{fresh['id']}") == final
        assert server.json("POST", url + "/render", json=options, headers=fresh_key)["id"] == fresh["id"]
        assert server.request("POST", url + "/voiceover", json=voice_body, headers=voice_key).status_code == 409
        assert len(server.json("GET", url + "/jobs")) == 3
        assert manifest(root) == final_files
        assert len((server.root / "tts-calls.txt").read_text().splitlines()) == 2
    finally:
        server.stop()
        pending.shutdown(wait=True, cancel_futures=True)
