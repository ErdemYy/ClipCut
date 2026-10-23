"""Veritabanı modelleri (SQLite / SQLModel)."""
from __future__ import annotations

import uuid
import copy
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column, inspect, text
from sqlmodel import Field, Session, SQLModel, create_engine, select

from .config import get_settings


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex[:12]


class Project(SQLModel, table=True):
    id: str = Field(default_factory=_id, primary_key=True)
    name: str
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
    # draft | generating | ready | failed
    status: str = "draft"
    origin: str = "upload"  # upload | veo | storyboard
    generation_prompt: Optional[str] = None

    source_file: Optional[str] = None  # proje klasörüne göre
    thumbnail_file: Optional[str] = None
    voiceover_file: Optional[str] = None
    duration: float = 0.0
    width: int = 0
    height: int = 0
    has_audio: bool = False

    transcript: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    subtitles: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    subtitle_language: Optional[str] = None

    plan: dict[str, Any] = Field(default_factory=lambda: {"operations": []}, sa_column=Column(JSON))
    plan_history: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    chat: list[Any] = Field(default_factory=list, sa_column=Column(JSON))

    output_file: Optional[str] = None
    output_meta: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    storyboard: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))


class Job(SQLModel, table=True):
    id: str = Field(default_factory=_id, primary_key=True)
    project_id: str = Field(index=True)
    kind: str  # generate | transcribe | translate | render
    status: str = "queued"  # queued | running | done | failed
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    result: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)
    finished_at: Optional[datetime] = None


engine = create_engine(get_settings().db_url, connect_args={"check_same_thread": False})


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    # Kolon göçü
    columns = {c["name"] for c in inspect(engine).get_columns("project")}
    with engine.begin() as conn:
        if "voiceover_file" not in columns:
            conn.execute(text("ALTER TABLE project ADD COLUMN voiceover_file VARCHAR"))
        if "storyboard" not in columns:
            conn.execute(text("ALTER TABLE project ADD COLUMN storyboard JSON"))
    # Yarım kalmış işleri başarısız işaretle (sunucu yeniden başlatıldıysa)
    with Session(engine) as s:
        for job in s.exec(select(Job).where(Job.status.in_(["queued", "running"]))).all():
            job.status = "failed"
            job.error = "Sunucu yeniden başlatıldı."
            s.add(job)
        for p in s.exec(select(Project).where(Project.status == "generating")).all():
            p.status = "ready" if p.storyboard and p.source_file else "failed"
            if p.storyboard:
                spec = copy.deepcopy(p.storyboard)
                spec["last_error"] = "Sunucu yeniden başlatıldı; hazır sahneler korunmuştur."
                for scene in spec.get("scenes", []):
                    if scene.get("status") == "generating":
                        scene.update(status="failed", error="Üretim yarım kaldı. Sağlayıcıda başlayan istek ücretlenmiş olabilir.")
                p.storyboard = spec
            s.add(p)
        s.commit()


def get_session():
    with Session(engine) as session:
        yield session
