"""Operator maintenance for durable idempotency reservations.

Completed responses are replayed only while their record exists. Expired records
are removed at server start (see ``Settings.idempotency_ttl_hours``) and from this
CLI. Unresolved (pending) reservations are never deleted automatically: they mean
"a mutation may already have reached the provider", so a human has to inspect the
project/job state and release the key explicitly.

Usage, from ``backend/``::

    .venv\\Scripts\\python.exe -m app.idempotency_admin list
    .venv\\Scripts\\python.exe -m app.idempotency_admin list --status pending
    .venv\\Scripts\\python.exe -m app.idempotency_admin release <key>
    .venv\\Scripts\\python.exe -m app.idempotency_admin purge --ttl-hours 168 --yes
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import inspect
from sqlmodel import Session, select

from . import models
from .config import get_settings
from .models import MutationRequest

STATUSES = ("all", "pending", "completed", "failed")
TABLE = MutationRequest.__tablename__


def table_available() -> bool:
    """A fresh database has no reservation table until the app's first start."""
    try:
        return inspect(models.engine).has_table(TABLE)
    except Exception:
        return False


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _status_of(record: MutationRequest) -> str:
    if record.status_code is None:
        return "pending"
    return "failed" if record.status_code >= 500 else "completed"


def list_records(*, status: str = "all", limit: int = 50,
                 now: datetime | None = None) -> list[dict[str, Any]]:
    """Newest-first records without bodies; ``now`` keeps age output deterministic."""
    if status not in STATUSES:
        raise ValueError(f"Geçersiz durum: {status}")
    limit = max(1, min(int(limit), 1000))
    if not table_available():
        return []
    current = now or datetime.now(timezone.utc)
    with Session(models.engine) as session:
        rows = session.exec(select(MutationRequest).order_by(MutationRequest.created_at.desc())).all()
        result = []
        for row in rows:
            state = _status_of(row)
            if status != "all" and state != status:
                continue
            created = _aware(row.created_at)
            result.append({
                "key": row.key,
                "status": state,
                "status_code": row.status_code,
                "created_at": created.isoformat(),
                "age_hours": round((current - created).total_seconds() / 3600, 1),
                "fingerprint": row.fingerprint[:16],
                "content_type": row.content_type,
            })
            if len(result) >= limit:
                break
        return result


def purge_expired(*, ttl_hours: int | None = None,
                  now: datetime | None = None) -> int:
    """Delete completed records older than the TTL; pending ones always stay."""
    ttl = get_settings().idempotency_ttl_hours if ttl_hours is None else int(ttl_hours)
    if ttl <= 0 or not table_available():
        return 0
    current = now or datetime.now(timezone.utc)
    cutoff = current - timedelta(hours=ttl)
    removed = 0
    with Session(models.engine) as session:
        rows = session.exec(select(MutationRequest).where(MutationRequest.status_code.is_not(None))).all()
        for row in rows:
            if _aware(row.created_at) < cutoff:
                session.delete(row)
                removed += 1
        if removed:
            session.commit()
    return removed


def release(key: str) -> bool:
    """Forget one unresolved reservation so the operator can retry deliberately.

    Completed records are not released: they replay a stored response and expire
    with the TTL instead. Returns True only when a pending record was removed.
    """
    if not table_available():
        return False
    with Session(models.engine) as session:
        record = session.get(MutationRequest, key)
        if record is None or record.status_code is not None:
            return False
        session.delete(record)
        session.commit()
        return True


def _print_records(rows: list[dict[str, Any]]) -> None:
    if not rows:
        print("Kayıt yok.")
        return
    print(f"{'DURUM':<10} {'YAŞ (sa)':>8}  {'OLUŞTURMA (UTC)':<20}  {'KOD':>4}  KİMLİK")
    for row in rows:
        code = "-" if row["status_code"] is None else str(row["status_code"])
        print(f"{row['status']:<10} {row['age_hours']:>8}  {row['created_at'][:19]:<20}  {code:>4}  {row['key']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.idempotency_admin",
                                     description="İstek kimliği kayıtlarını incele ve temizle.")
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list", help="Kayıtları listele (gövdeler gösterilmez).")
    listing.add_argument("--status", choices=STATUSES, default="all")
    listing.add_argument("--limit", type=int, default=50)

    releasing = sub.add_parser("release", help="Belirsiz (pending) bir kimliği serbest bırak.")
    releasing.add_argument("key")

    purging = sub.add_parser("purge", help="Süresi dolmuş tamamlanmış kayıtları sil.")
    purging.add_argument("--ttl-hours", type=int, default=None,
                         help="Varsayılan: IDEMPOTENCY_TTL_HOURS veya 168 saat.")
    purging.add_argument("--yes", action="store_true", help="Onay olmadan silme yapılmaz.")

    args = parser.parse_args(argv)
    if args.command == "list":
        if not table_available():
            print("İstek kimliği tablosu henüz yok; sunucu ilk kez açıldığında oluşturulur.")
            return 0
        _print_records(list_records(status=args.status, limit=args.limit))
        return 0
    if args.command == "release":
        if release(args.key):
            print(f"Serbest bırakıldı: {args.key}")
            print("Aynı kimlikle yeni bir deneme artık yeni istek sayılır; önce proje ve iş listesini kontrol edin.")
            return 0
        print("Serbest bırakılmadı: kimlik yok, zaten tamamlanmış veya geçersiz.", file=sys.stderr)
        return 1
    if not args.yes:
        print("Silmek için --yes ekleyin. Önce 'list' ile kayıtları inceleyin.", file=sys.stderr)
        return 2
    removed = purge_expired(ttl_hours=args.ttl_hours)
    ttl = get_settings().idempotency_ttl_hours if args.ttl_hours is None else args.ttl_hours
    print(f"{removed} tamamlanmış kayıt silindi (TTL {ttl} saat). Bekleyen kayıtlara dokunulmadı.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
