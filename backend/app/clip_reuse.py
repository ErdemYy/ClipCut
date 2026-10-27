"""Conservative, local-only reuse of verified analyzed-clip MP4/JPG pairs."""
from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path

from .publishing import FORMAT_NAMES


def file_sha256(path: Path) -> str | None:
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return None
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _same_number(a, b) -> bool:
    return (isinstance(a, (int, float)) and not isinstance(a, bool)
            and isinstance(b, (int, float)) and not isinstance(b, bool)
            and math.isfinite(a) and math.isfinite(b) and abs(a - b) < 1e-9)


def _output_path(url, project_id: str, root: Path, stem: str, suffix: str) -> Path | None:
    if not isinstance(url, str):
        return None
    match = re.fullmatch(r"/media/projects/" + re.escape(project_id)
                         + r"/outputs/([a-f0-9]{32})/" + re.escape(stem + suffix), url)
    if not match:
        return None
    path = root.resolve() / "outputs" / match[1] / (stem + suffix)
    # Reject redirected directories/symlinks, escapes, encoded paths and URLs.
    if path.resolve() != path or not path.is_file():
        return None
    return path


def reusable_clip_output(previous: dict | None, *, project_id: str, project_path: Path,
                         revision: str, source_sha256: str | None, options: dict,
                         clip: dict, aspect: str) -> dict | None:
    """Return a verified pair or None; uncertain/legacy results must render again."""
    try:
        if not previous or previous.get("project_id") != project_id or not source_sha256:
            return None
        result = previous.get("result")
        if not isinstance(result, dict):
            return None
        request = result.get("clip_request")
        if not isinstance(request, dict) or not options.get("analysis_id"):
            return None
        if (request.get("analysis_id") != options["analysis_id"]
                or request.get("render_revision") != revision
                or request.get("source_sha256") != source_sha256
                or any(request.get(key) != options[key] for key in ("fill", "resolution", "quality"))):
            return None
        formats = request.get("aspect_ratios") or [request.get("aspect_ratio")]
        if not isinstance(formats, list) or aspect not in formats:
            return None
        old_clips = request.get("clips")
        if not isinstance(old_clips, list) or any(not isinstance(item, dict) for item in old_clips):
            return None
        ids = [item.get("id") for item in old_clips]
        if len(set(ids)) != len(ids) or any(type(i) is not int or i < 0 for i in ids) or clip["id"] not in ids:
            return None
        ordinal = ids.index(clip["id"]) + 1
        old_clip = old_clips[ordinal - 1]
        if (not _same_number(old_clip.get("start"), clip["start"])
                or not _same_number(old_clip.get("end"), clip["end"])
                or not _same_number(old_clip.get("cover_at", 0), clip.get("cover_at", 0))):
            return None
        outputs = result.get("outputs")
        if not isinstance(outputs, list):
            return None
        matches = [out for out in outputs if isinstance(out, dict)
                   and type(out.get("clip_index")) is int and out["clip_index"] == ordinal
                   and out.get("aspect_ratio") == aspect]
        if len(matches) != 1:
            return None
        out = matches[0]
        stem = f"clip_{ordinal:02d}_{FORMAT_NAMES[aspect]}"
        video = _output_path(out.get("output"), project_id, project_path, stem, ".mp4")
        thumb = _output_path(out.get("thumbnail"), project_id, project_path, stem, ".jpg")
        if not video or not thumb or video.parent != thumb.parent:
            return None
        for key, path in (("sha256", video), ("thumbnail_sha256", thumb)):
            expected = out.get(key)
            if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or file_sha256(path) != expected:
                return None
        for key in ("width", "height", "duration", "cover_at", "cover_source_at"):
            value = out.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                return None
        if min(out["width"], out["height"], out["duration"]) <= 0 or type(out.get("thumbnail_fallback")) is not bool:
            return None
        metadata = {key: out[key] for key in ("width", "height", "duration", "cover_at", "cover_source_at", "thumbnail_fallback")}
        return {"video": video, "thumbnail": thumb, "metadata": metadata,
                "sha256": out["sha256"], "thumbnail_sha256": out["thumbnail_sha256"]}
    except (KeyError, TypeError, ValueError, OSError, OverflowError, RuntimeError):
        return None
