"""Guarded cleanup of generated publish output directories.

Publishing jobs create ``outputs/<32-hex>/`` folders. They are never overwritten,
so incremental work accumulates disk usage. This module only offers folders that
are old, not referenced by any stored job result and made exclusively of plain
files. Source media, covers, project edits and main renders are outside these
folders and are never touched.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import time
from pathlib import Path
from typing import Any, Iterable

from pydantic import BaseModel, Field, field_validator

TOKEN_RE = re.compile(r"^[a-f0-9]{32}$")
MIN_AGE_SECONDS = 60 * 60
MAX_TOKENS = 50

_REFERENCE_RE = re.compile(r"/media/projects/([A-Za-z0-9_-]+)/outputs/([a-f0-9]{32})/")
_RELATIVE_REFERENCE_RE = re.compile(r"(?:^|[\\/])outputs[\\/]([a-f0-9]{32})(?:[\\/]|$)")


class OutputCleanupBody(BaseModel):
    tokens: list[str] = Field(..., min_length=1, max_length=MAX_TOKENS)

    @field_validator("tokens")
    @classmethod
    def _unique_tokens(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("Her çıktı klasörü bir kez gönderilmeli.")
        if any(not TOKEN_RE.fullmatch(token) for token in values):
            raise ValueError("Geçersiz çıktı klasörü.")
        return values


def referenced_tokens(project_id: str, values: Iterable[Any]) -> set[str]:
    """Collect output tokens referenced by stored results or project paths."""
    tokens: set[str] = set()
    for value in values:
        tokens.update(_tokens_in(project_id, value))
    return tokens


def _tokens_in(project_id: str, value: Any) -> set[str]:
    if isinstance(value, str):
        absolute = list(_REFERENCE_RE.finditer(value))
        if absolute:
            return {match.group(2) for match in absolute if match.group(1) == project_id}
        return set(_RELATIVE_REFERENCE_RE.findall(value))
    if isinstance(value, dict):
        return set().union(*(_tokens_in(project_id, item) for item in value.values())) if value else set()
    if isinstance(value, (list, tuple, set)):
        return set().union(*(_tokens_in(project_id, item) for item in value)) if value else set()
    return set()


def _is_link(path: Path) -> bool:
    """Reject symlinks and Windows junctions without following them."""
    try:
        if path.is_symlink():
            return True
        if os.name == "nt":
            attributes = path.stat(follow_symlinks=False).st_file_attributes
            return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except OSError:
        return True
    return False


def _measure(directory: Path) -> tuple[int, int, str | None]:
    """Return (bytes, files, unsafe reason). Never follows links or nested dirs."""
    size = files = 0
    try:
        for item in directory.rglob("*"):
            if _is_link(item):
                return size, files, "symlink"
            if item.is_dir():
                return size, files, "nested"
            if not item.is_file():
                return size, files, "special"
            size += item.stat().st_size
            files += 1
    except OSError:
        return size, files, "unreadable"
    return size, files, None


def scan_outputs(project_path: Path, referenced: set[str], *,
                 min_age_seconds: int = MIN_AGE_SECONDS, now: float | None = None
                 ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (eligible, protected) output folders for the project.

    ``referenced`` must include every token used by stored jobs. Recent folders
    are protected so an in-flight publishing job is never removed.
    """
    root = project_path / "outputs"
    current = time.time() if now is None else now
    eligible: list[dict[str, Any]] = []
    protected: list[dict[str, Any]] = []
    if not root.is_dir() or _is_link(root):
        return eligible, protected
    try:
        entries = sorted(root.iterdir(), key=lambda entry: entry.name)
    except OSError:
        return eligible, protected
    for entry in entries:
        if not TOKEN_RE.fullmatch(entry.name):
            continue
        if _is_link(entry):
            protected.append({"token": entry.name, "bytes": 0, "files": 0, "age_seconds": 0,
                              "reason": "symlink"})
            continue
        if not entry.is_dir():
            continue
        size, files, unsafe = _measure(entry)
        try:
            age = max(0.0, current - entry.stat().st_mtime)
        except OSError:
            age = 0.0
        item = {"token": entry.name, "bytes": size, "files": files, "age_seconds": int(age)}
        if unsafe:
            protected.append({**item, "reason": unsafe})
        elif entry.name in referenced:
            protected.append({**item, "reason": "referenced"})
        elif age < min_age_seconds:
            protected.append({**item, "reason": "recent"})
        else:
            eligible.append(item)
    return eligible, protected


def cleanup_outputs(project_path: Path, referenced: set[str], requested: Iterable[str], *,
                    min_age_seconds: int = MIN_AGE_SECONDS, now: float | None = None) -> dict[str, Any]:
    """Delete requested folders that are still eligible, reporting every outcome."""
    eligible, protected = scan_outputs(project_path, referenced, min_age_seconds=min_age_seconds, now=now)
    allowed = {item["token"]: item for item in eligible}
    deleted: list[dict[str, Any]] = []
    failed: list[str] = []
    skipped: list[str] = []
    for token in dict.fromkeys(requested):
        item = allowed.get(token)
        if item is None:
            skipped.append(token)
            continue
        try:
            shutil.rmtree(project_path / "outputs" / token)
        except OSError:
            failed.append(token)
            continue
        deleted.append(item)
    remaining = [item for item in eligible if item["token"] not in {entry["token"] for entry in deleted}]
    return {
        "deleted": deleted,
        "freed_bytes": sum(item["bytes"] for item in deleted),
        "failed": failed,
        "skipped": skipped,
        "eligible": remaining,
        "protected": protected,
    }
