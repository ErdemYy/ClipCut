import type { ClipRange } from "./clip-trim";

export function clipCoverMax(range: ClipRange): number {
  const length = range.end - range.start;
  return Number.isFinite(length) ? Math.max(0, Math.floor((length - 0.1 + 1e-9) * 1000) / 1000) : 0;
}

export function clipCoverError(at: number, range: ClipRange): string | null {
  if (![at, range.start, range.end].every(Number.isFinite) || range.start < 0 || at < 0
    || range.end - range.start - at < 0.1 - 1e-9)
    return "Kapak zamanı klip içinde olmalı; klip sonunda en az 0,1 sn kalmalı.";
  return null;
}
