"""Test-only Uvicorn bootstrap: isolated settings, local TTS and publication gates.

Run only through test_process_restart.py. Never points at the person's DB/assets
or contacts a provider. Gates stop *after* local FFmpeg exits, avoiding orphaned
encoders when the owned Python process is forcibly killed.
"""
from __future__ import annotations

import socket
import sys
import time
from pathlib import Path


def main() -> None:
    root, port, token = Path(sys.argv[1]).resolve(), int(sys.argv[2]), sys.argv[3]
    from app import config

    settings = config.Settings(
        storage_dir=root / "storage", assets_dir=root / "assets",
        database_url=f"sqlite:///{(root / 'restart.db').as_posix()}",
        gemini_api_key="", mock_ai="true", ffmpeg_path=sys.argv[4], _env_file=None,
    )
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    (settings.storage_dir / "projects").mkdir(exist_ok=True)
    (settings.assets_dir / "fonts").mkdir(parents=True, exist_ok=True)
    config.get_settings = lambda: settings

    # Defense in depth: even an accidental SDK/font request cannot leave loopback.
    original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def allowed(address) -> None:
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError("External networking is forbidden in restart smoke tests")

    def connect(sock, address):
        allowed(address)
        return original_connect(sock, address)

    def connect_ex(sock, address):
        allowed(address)
        return original_connect_ex(sock, address)

    socket.socket.connect, socket.socket.connect_ex = connect, connect_ex

    from app import jobs, main as api
    from app.ffmpeg import run_ffmpeg

    api.assets.ensure_assets = lambda: None

    def forbidden(*args, **kwargs):
        raise AssertionError("AI providers are forbidden in restart smoke tests")

    for name in ("generate_video", "transcribe", "translate", "plan_edit"):
        setattr(api.ai, name, forbidden)

    def gate(kind: str, value: str) -> None:
        hold = root / f"hold-{kind}"
        if not hold.exists():
            return
        (root / f"entered-{kind}").write_text(value, encoding="utf-8")
        deadline = time.monotonic() + 60
        while hold.exists():
            if time.monotonic() > deadline:
                raise TimeoutError(f"Restart test {kind} gate was not released")
            time.sleep(0.05)

    real_render = jobs.render

    def render(req, progress):
        result = real_render(req, progress)  # Actual local FFmpeg, not a synthetic render result.
        gate("render", str(req.output))
        return result

    jobs.render = render

    def local_voiceover(text, *, voice_id, speed, out_path):
        with (root / "tts-calls.txt").open("a", encoding="utf-8") as log:
            log.write("local sine voice\n")
        run_ffmpeg(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
                    "-t", "2", "-c:a", "libmp3lame", str(out_path)], timeout=15)
        gate("tts", str(out_path))
        words = [{"text": "Local", "start": 0.1, "end": 0.8},
                 {"text": "voice", "start": 0.8, "end": 1.8}]
        return {"language": "en", "duration": 2, "words": words,
                "segments": [{"id": 0, "start": 0.1, "end": 1.8, "text": "Local voice", "words": words}]}

    api.tts.generate_voiceover = local_voiceover

    @api.app.middleware("http")
    async def identify_owned_server(request, call_next):
        response = await call_next(request)
        response.headers["X-Restart-Test"] = token
        return response

    import uvicorn

    uvicorn.run(api.app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
