"""FFmpeg yardımcıları: ikili dosyayı bulma, medya analizi, sessizlik tespiti, ilerleme takibi."""
from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Sequence

from .config import get_settings


class FFmpegError(RuntimeError):
    pass


@lru_cache
def ffmpeg_exe() -> str:
    configured = get_settings().ffmpeg_path
    if configured:
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover
        raise FFmpegError("FFmpeg bulunamadı. FFMPEG_PATH ayarlayın veya FFmpeg kurun.") from exc


def _creationflags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run_ffmpeg(args: Sequence[str], cwd: Path | None = None, timeout: float | None = None) -> subprocess.CompletedProcess:
    cmd = [ffmpeg_exe(), "-hide_banner", "-y", *args]
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, creationflags=_creationflags(),
    )
    if proc.returncode != 0:
        raise FFmpegError(_tail(proc.stderr))
    return proc


def run_ffmpeg_with_progress(
    args: Sequence[str], total_seconds: float, on_progress: Callable[[float], None], cwd: Path | None = None,
) -> None:
    cmd = [ffmpeg_exe(), "-hide_banner", "-y", "-nostats", "-progress", "pipe:1", *args]
    proc = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace", creationflags=_creationflags(),
    )
    stderr_lines: list[str] = []

    import threading

    def _drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)
            if len(stderr_lines) > 400:
                del stderr_lines[:200]

    drainer = threading.Thread(target=_drain, daemon=True)
    drainer.start()
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                micro = int(line.split("=", 1)[1].strip())
            except ValueError:
                continue
            if total_seconds > 0:
                on_progress(max(0.0, min(1.0, micro / 1_000_000 / total_seconds)))
    proc.wait()
    drainer.join(timeout=2)
    if proc.returncode != 0:
        raise FFmpegError(_tail("".join(stderr_lines)))


def _tail(text: str, lines: int = 25) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    has_video: bool


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VIDEO_RE = re.compile(r"Stream #.*?Video:.*?(\d{2,5})x(\d{2,5})")
_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_ROTATE_RE = re.compile(r"rotate\s*:\s*(-?\d+)|rotation of (-?\d+(?:\.\d+)?) degrees")


def probe(path: Path) -> MediaInfo:
    """ffprobe olmadan `ffmpeg -i` çıktısını ayrıştırarak medya bilgisi döner."""
    proc = subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True,
        encoding="utf-8", errors="replace", creationflags=_creationflags(),
    )
    out = proc.stderr
    m = _DURATION_RE.search(out)
    if not m:
        raise FFmpegError("Medya dosyası okunamadı: " + _tail(out, 5))
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    width = height = 0
    fps = 30.0
    has_video = False
    for line in out.splitlines():
        if "Video:" in line and "Stream #" in line and not has_video:
            vm = _VIDEO_RE.search(line)
            if vm:
                width, height = int(vm.group(1)), int(vm.group(2))
                has_video = True
            fm = _FPS_RE.search(line)
            if fm:
                fps = float(fm.group(1))
    rot = _ROTATE_RE.search(out)
    if rot:
        angle = abs(int(float(rot.group(1) or rot.group(2)))) % 180
        if angle == 90:
            width, height = height, width
    has_audio = bool(re.search(r"Stream #.*Audio:", out))
    return MediaInfo(duration=duration, width=width, height=height, fps=fps or 30.0, has_audio=has_audio, has_video=has_video)


_SIL_START = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SIL_END = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")


def detect_silences(path: Path, threshold_db: float, min_silence_s: float, duration: float) -> list[tuple[float, float]]:
    proc = run_ffmpeg(
        ["-i", str(path), "-vn", "-af", f"silencedetect=noise={threshold_db}dB:d={min_silence_s}", "-f", "null", "-"]
    )
    silences: list[tuple[float, float]] = []
    start: float | None = None
    for line in proc.stderr.splitlines():
        sm = _SIL_START.search(line)
        if sm:
            start = max(0.0, float(sm.group(1)))
            continue
        em = _SIL_END.search(line)
        if em and start is not None:
            silences.append((start, float(em.group(1))))
            start = None
    if start is not None:
        silences.append((start, duration))
    return silences


def make_thumbnail(src: Path, dst: Path, at: float = 1.0) -> None:
    run_ffmpeg(["-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(dst)])
    if not dst.is_file() or dst.stat().st_size == 0:
        raise FFmpegError("Seçilen zamanda video karesi bulunamadı.")


def extract_audio(src: Path, dst: Path) -> None:
    run_ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", str(dst)])
