"""Kaynak zaman çizelgesinden çıktı zaman çizelgesine eşleme (kesme, sessizlik, hız, geçiş)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

from .schema import EditPlan

Interval = tuple[float, float]
SilenceProvider = Callable[[float, float], list[Interval]]

MIN_SEGMENT = 0.15


def subtract(intervals: list[Interval], remove: Interval) -> list[Interval]:
    rs, re_ = remove
    out: list[Interval] = []
    for s, e in intervals:
        if re_ <= s or rs >= e:
            out.append((s, e))
            continue
        if rs > s:
            out.append((s, rs))
        if re_ < e:
            out.append((re_, e))
    return out


@dataclass
class Timeline:
    source_duration: float
    segments: list[Interval]
    speed: float = 1.0
    crossfade: float = 0.0
    offsets: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.offsets = []
        acc = 0.0
        for i, (s, e) in enumerate(self.segments):
            self.offsets.append(acc)
            acc += (e - s) - (self.crossfade if i < len(self.segments) - 1 else 0.0)

    @property
    def edited_length(self) -> float:
        """Hız uygulanmadan önceki toplam süre."""
        if not self.segments:
            return 0.0
        s, e = self.segments[-1]
        return self.offsets[-1] + (e - s)

    @property
    def output_duration(self) -> float:
        return self.edited_length / self.speed

    def map_time(self, t: float) -> Optional[float]:
        """Kaynak zamanını çıktı zamanına çevirir; kesilmiş bir bölgedeyse None."""
        for (s, e), off in zip(self.segments, self.offsets):
            if s - 1e-6 <= t <= e + 1e-6:
                return (off + (t - s)) / self.speed
        return None

    def map_range(self, start: float, end: float) -> Optional[Interval]:
        """Kaynak aralığının görünür kısmını çıktı zamanına çevirir."""
        for (s, e), off in zip(self.segments, self.offsets):
            a, b = max(start, s), min(end, e)
            if b - a > 0.02:
                return ((off + a - s) / self.speed, (off + b - s) / self.speed)
        return None

    def to_dict(self) -> dict:
        return {
            "source_duration": round(self.source_duration, 3),
            "segments": [[round(s, 3), round(e, 3)] for s, e in self.segments],
            "speed": self.speed,
            "crossfade": self.crossfade,
            "output_duration": round(self.output_duration, 3),
        }


def build_timeline(plan: EditPlan, duration: float, silence_provider: SilenceProvider | None = None) -> Timeline:
    segments: list[Interval] = [(0.0, duration)]

    trim = plan.first("trim")
    if trim:
        end = trim.end if trim.end is not None and trim.end > trim.start else duration
        segments = [(max(0.0, trim.start), min(duration, end))]

    for cut in plan.all("cut_range"):
        if cut.end > cut.start:
            segments = subtract(segments, (cut.start, cut.end))

    rs = plan.first("remove_silence")
    if rs and silence_provider:
        pad = rs.padding_ms / 1000
        for s, e in silence_provider(rs.threshold_db, rs.min_silence_ms / 1000):
            if e - s > 2 * pad:
                segments = subtract(segments, (s + pad, e - pad))

    segments = [(s, e) for s, e in segments if e - s >= MIN_SEGMENT]
    if not segments:
        segments = [(0.0, duration)]

    speed_op = plan.first("speed")
    speed = speed_op.factor if speed_op else 1.0

    tr = plan.first("transition")
    crossfade = 0.0
    if tr and len(segments) > 1:
        shortest = min(e - s for s, e in segments)
        crossfade = min(tr.duration, shortest / 2.5)
        if crossfade < 0.08:
            crossfade = 0.0

    return Timeline(source_duration=duration, segments=segments, speed=speed, crossfade=crossfade)
