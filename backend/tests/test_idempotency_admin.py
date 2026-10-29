"""Idempotency maintenance regressions: TTL purge, listing and explicit release."""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone

os.environ.setdefault("MOCK_AI", "true")

import pytest
from sqlmodel import SQLModel, Session, create_engine, select

from app import config, idempotency_admin, main, models
from app.models import MutationRequest

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def db(tmp_path, monkeypatch):
    settings = config.Settings(storage_dir=tmp_path / "store", mock_ai="true",
                               idempotency_ttl_hours=24, _env_file=None)
    settings.storage_dir.mkdir()
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(models, "engine", engine)
    monkeypatch.setattr(idempotency_admin, "get_settings", lambda: settings)
    try:
        yield engine, settings
    finally:
        engine.dispose()


def _add(engine, key: str, *, age_hours: float, status_code: int | None) -> None:
    with Session(engine) as session:
        session.add(MutationRequest(
            key=key, fingerprint="f" * 64, status_code=status_code,
            response_body=None if status_code is None else '{"ok": true}',
            created_at=NOW - timedelta(hours=age_hours)))
        session.commit()


def _keys(engine) -> set[str]:
    with Session(engine) as session:
        return {row.key for row in session.exec(select(MutationRequest)).all()}


def test_purge_removes_only_completed_records_past_ttl(db):
    engine, _ = db
    _add(engine, "old-completed", age_hours=48, status_code=200)
    _add(engine, "old-failed", age_hours=30, status_code=409)
    _add(engine, "recent-completed", age_hours=1, status_code=200)
    _add(engine, "old-pending", age_hours=72, status_code=None)

    assert idempotency_admin.purge_expired(ttl_hours=24, now=NOW) == 2
    assert _keys(engine) == {"recent-completed", "old-pending"}


def test_purge_uses_configured_ttl_and_can_be_disabled(db):
    engine, settings = db
    _add(engine, "three-hours", age_hours=3, status_code=200)
    _add(engine, "two-hours", age_hours=2, status_code=200)

    assert idempotency_admin.purge_expired(ttl_hours=0, now=NOW) == 0
    assert len(_keys(engine)) == 2

    settings.idempotency_ttl_hours = 2
    assert idempotency_admin.purge_expired(now=NOW) == 1
    assert _keys(engine) == {"two-hours"}


def test_release_removes_pending_only(db):
    engine, _ = db
    _add(engine, "pending", age_hours=5, status_code=None)
    _add(engine, "completed", age_hours=5, status_code=200)

    assert idempotency_admin.release("pending") is True
    assert _keys(engine) == {"completed"}
    assert idempotency_admin.release("completed") is False
    assert idempotency_admin.release("missing") is False
    assert _keys(engine) == {"completed"}


def test_list_records_filters_orders_and_limits(db):
    engine, _ = db
    _add(engine, "old-pending", age_hours=10, status_code=None)
    _add(engine, "new-pending", age_hours=1, status_code=None)
    _add(engine, "replayed", age_hours=2, status_code=200)
    _add(engine, "ambiguous", age_hours=3, status_code=503)

    pending = idempotency_admin.list_records(status="pending", limit=10, now=NOW)
    assert [row["key"] for row in pending] == ["new-pending", "old-pending"]
    assert pending[0]["age_hours"] == 1.0
    assert pending[0]["status_code"] is None

    assert [row["key"] for row in idempotency_admin.list_records(status="failed", now=NOW)] == ["ambiguous"]
    assert [row["key"] for row in idempotency_admin.list_records(status="completed", now=NOW)] == ["replayed"]
    assert len(idempotency_admin.list_records(limit=1, now=NOW)) == 1
    assert len(idempotency_admin.list_records(limit=0, now=NOW)) == 1
    with pytest.raises(ValueError):
        idempotency_admin.list_records(status="unknown")


def test_cli_release_purge_and_list(db, capsys, monkeypatch):
    engine, settings = db
    _add(engine, "pending", age_hours=5, status_code=None)
    _add(engine, "old-completed", age_hours=48, status_code=200)

    assert idempotency_admin.main(["list", "--status", "pending"]) == 0
    assert "pending" in capsys.readouterr().out

    assert idempotency_admin.main(["release", "missing"]) == 1
    assert idempotency_admin.main(["release", "pending"]) == 0

    monkeypatch.setattr(settings, "idempotency_ttl_hours", 24)
    assert idempotency_admin.main(["purge"]) == 2          # confirmation required
    assert "old-completed" in _keys(engine)
    assert idempotency_admin.main(["purge", "--yes"]) == 0
    assert "old-completed" not in _keys(engine)


def test_startup_purges_expired_keys_and_survives_failure(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(main, "init_db", lambda: None)
    monkeypatch.setattr(main.assets, "ensure_assets", lambda: None)
    monkeypatch.setattr(main.output_cleanup, "purge_all_expired_trash", lambda _: None)
    monkeypatch.setattr(main.idempotency_admin, "purge_expired", lambda: calls.append("purge") or 0)

    async def enter_and_exit():
        async with main.lifespan(main.app):
            pass

    asyncio.run(enter_and_exit())
    assert calls == ["purge"]

    def boom():
        raise RuntimeError("disk unavailable")

    monkeypatch.setattr(main.idempotency_admin, "purge_expired", boom)
    asyncio.run(enter_and_exit())  # maintenance failure must not block startup
