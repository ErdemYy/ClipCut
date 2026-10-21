"""Veritabanı modelleri (SQLite / SQLModel)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, Session, SQLModel, create_engine

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
    origin: str = "upload"  # upload | veo
    generation_prompt: Optional[str] = None

    source_file: Optional[str] = None  # proje klasörüne göre
    thumbnail_file: Optional[str] = None
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
    # Yarım kalmış işleri başarısız işaretle (sunucu yeniden başlatıldıysa)
    with Session(engine) as s:
        for job in s.query(Job).filter(Job.status.in_(["queued", "running"])).all():  # type: ignore[attr-defined]
            job.status = "failed"
            job.error = "Sunucu yeniden başlatıldı."
            s.add(job)
        for p in s.query(Project).filter(Project.status == "generating").all():  # type: ignore[attr-defined]
            p.status = "failed"
            s.add(p)
        s.commit()


def get_session():
    with Session(engine) as session:
        yield session
