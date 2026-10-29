"""Durable, fail-closed idempotency for JSON mutation requests (no provider retries)."""
from __future__ import annotations

import hashlib
import json
import re

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from . import models
from .models import MutationRequest


async def protect(request: Request, call_next):
    key = request.headers.get("Idempotency-Key")
    if not key or request.method not in ("POST", "PUT", "PATCH", "DELETE") or not request.url.path.startswith("/api/"):
        return await call_next(request)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", key):
        return JSONResponse({"detail": "Geçersiz istek kimliği."}, status_code=422)
    # Multipart uploads are intentionally outside this protocol.
    if "multipart/form-data" in request.headers.get("content-type", ""):
        return JSONResponse({"detail": "Dosya yüklemede istek kimliği desteklenmiyor."}, status_code=422)
    body = await request.body()
    try:
        body = json.dumps(json.loads(body), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    except (ValueError, UnicodeError):
        pass
    fingerprint = hashlib.sha256(request.method.encode() + b"\n" +
        str(request.url.path).encode() + b"?" + request.url.query.encode() + b"\n" + body).hexdigest()
    with Session(models.engine) as session:
        record = MutationRequest(key=key, fingerprint=fingerprint)
        session.add(record)
        try:
            session.commit()  # Unique primary key arbitrates concurrent requests, even across processes.
        except IntegrityError:
            session.rollback()
            previous = session.get(MutationRequest, key)
            if previous.fingerprint != fingerprint:
                return JSONResponse({"detail": "Bu istek kimliği farklı bir işlem için kullanılmış."},
                    status_code=409, headers={"Idempotency-Status": "conflict"})
            if previous.status_code is None:
                return JSONResponse({"detail": "Bu istek sürüyor veya sonucu belirsiz. Yeni üretim başlatmadan proje ve iş listesini kontrol edin; otomatik tekrar yapılmadı."},
                    status_code=409, headers={"Idempotency-Status": "pending"})
            return Response(previous.response_body, status_code=previous.status_code,
                headers={"Content-Type": previous.content_type, "Idempotency-Status": "replayed"})
    # Exceptions, process death and 5xx leave the durable reservation unresolved.
    # Never guess that a provider did not already receive the request.
    response = await call_next(request)
    if response.status_code >= 500:
        response.headers["Idempotency-Status"] = "pending"
        return response
    chunks = [chunk async for chunk in response.body_iterator]
    payload = b"".join(chunks)
    with Session(models.engine) as session:
        record = session.get(MutationRequest, key)
        record.status_code = response.status_code
        record.response_body = payload.decode("utf-8")
        record.content_type = response.headers.get("content-type", "application/json")
        session.add(record)
        session.commit()
    return Response(payload, status_code=response.status_code,
        headers={**dict(response.headers), "Idempotency-Status": "completed"})
