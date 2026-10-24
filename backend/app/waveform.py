"""Bounded-memory source-audio peak extraction; local FFmpeg only, no AI."""
from __future__ import annotations

from array import array
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import uuid

from .ffmpeg import run_ffmpeg

SAMPLE_RATE = 8000
BINS = 1024
_lock = threading.Lock()  # Strict-mode/double requests share one extraction/cache result.


class SourceChangedError(ValueError):
    pass


def pcm_peaks(path: Path, duration: float, bins: int = BINS) -> list[float]:
    total_samples = max(1, math.ceil(duration * SAMPLE_RATE))
    peaks = [0] * bins
    position = 0
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            samples = array("h")
            samples.frombytes(chunk)
            if sys.byteorder != "little":
                samples.byteswap()
            for sample in samples:
                bucket = min(bins - 1, position * bins // total_samples)
                peaks[bucket] = max(peaks[bucket], abs(sample))
                position += 1
    return [round(value / 32768, 6) for value in peaks]


def source_waveform(source: Path, cache_dir: Path, duration: float, has_audio: bool) -> dict:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Ses dalgası için geçerli video süresi gerekir.")
    with _lock:
        stat = source.stat()
        identity = f"v1:{source.resolve().as_posix()}:{stat.st_size}:{stat.st_mtime_ns}:{duration}:{has_audio}"
        revision = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        result = {"duration": duration, "has_audio": has_audio, "revision": revision,
                  "sample_rate": SAMPLE_RATE, "peaks": []}
        if not has_audio:
            return result
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache = cache_dir / f"{revision}.json"
        try:
            saved = json.loads(cache.read_text(encoding="utf-8"))
            peaks = saved["peaks"]
            if (saved["revision"] == revision and len(peaks) == BINS
                    and all(isinstance(p, (int, float)) and math.isfinite(p) and 0 <= p <= 1 for p in peaks)):
                return saved
        except (OSError, ValueError, KeyError, TypeError):
            pass
        # Temporary PCM is on disk, streamed in small blocks, and removed even on
        # failures. A 120s FFmpeg timeout bounds analysis work on large/bad files.
        with tempfile.TemporaryDirectory(prefix="pcm_", dir=cache_dir) as temporary:
            pcm = Path(temporary) / "audio.pcm"
            run_ffmpeg(["-i", str(source), "-map", "0:a:0", "-vn", "-t", f"{duration:.6f}",
                        "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "s16le", str(pcm)], timeout=120)
            result["peaks"] = pcm_peaks(pcm, duration)
        after = source.stat()
        if (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise SourceChangedError("Kaynak dosya analiz sırasında değişti; ses dalgasını yeniden yükleyin.")
        temporary_cache = cache_dir / f"{uuid.uuid4().hex}.tmp"
        try:
            temporary_cache.write_text(json.dumps(result), encoding="utf-8")
            temporary_cache.replace(cache)
        finally:
            temporary_cache.unlink(missing_ok=True)
        return result
