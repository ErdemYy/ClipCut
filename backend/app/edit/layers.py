"""Output-clock layer edits: clients can change timing, not replace operations."""
from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field

from .schema import EditPlan


class LayerTiming(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    index: int = Field(ge=0, strict=True)
    start: float = Field(ge=0)
    duration: float = Field(ge=0.1, le=600)


class LayerTimingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    layers: list[LayerTiming] = Field(min_length=1, max_length=1000)


def timeline_revision(snapshot: dict) -> str:
    state = {key: snapshot.get(key) for key in ("source_file", "plan")}
    state["duration"] = float(snapshot.get("duration", 0))
    return hashlib.sha256(json.dumps(state, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def update_layer_timings(plan: EditPlan, body: LayerTimingsBody, total: float) -> EditPlan:
    operations = [op.model_copy(deep=True) for op in plan.operations]
    seen = set()
    for layer in body.layers:
        if layer.index in seen:
            raise ValueError("Bir katman aynı istekte birden fazla kez değiştirilemez.")
        seen.add(layer.index)
        if layer.index >= len(operations) or operations[layer.index].type not in {"text", "overlay"}:
            raise ValueError("Yalnızca mevcut metin ve B-roll katmanlarının zamanları düzenlenebilir.")
        if layer.start + layer.duration > total + 0.000001:
            raise ValueError(f"Katman düzenlenmiş video sınırını ({total:.3f} sn) aşamaz.")
        operations[layer.index] = operations[layer.index].model_copy(update={"start": layer.start, "duration": layer.duration})
    return EditPlan.model_validate({"operations": [op.model_dump() for op in operations]})
