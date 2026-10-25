export type ClipEdge = "start" | "end";
export type ClipRangeAction = ClipEdge | "move";
export type ClipRange = { start: number; end: number };

export const CLIP_MIN_SECONDS = 30;
export const CLIP_MAX_SECONDS = 60;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 1e3) / 1e3;

export function nearestBoundary(value: number, boundaries: number[]): number {
  if (!Number.isFinite(value) || boundaries.length === 0) return value;
  let best = boundaries[0];
  for (const boundary of boundaries) {
    if (Math.abs(boundary - value) < Math.abs(best - value)) best = boundary;
  }
  return round(best);
}

export function clipRangeError(range: ClipRange, duration: number): string | null {
  if (![range.start, range.end, duration].every(Number.isFinite))
    return "Başlangıç, bitiş ve kaynak süresi sayısal olmalı.";
  if (duration <= 0 || range.start < 0 || range.end > duration + 1e-6)
    return "Aralık kaynak video sınırları içinde olmalı.";
  if (range.end <= range.start) return "Bitiş başlangıçtan sonra olmalı.";
  const length = range.end - range.start;
  if (length < CLIP_MIN_SECONDS - 1e-6 || length > CLIP_MAX_SECONDS + 1e-6)
    return `Klip süresi ${CLIP_MIN_SECONDS}–${CLIP_MAX_SECONDS} saniye arasında olmalı.`;
  return null;
}

export function clampClipRange(range: ClipRange, duration: number): ClipRange {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return {
    start: round(clamp(Number.isFinite(range.start) ? range.start : 0, 0, total)),
    end: round(clamp(Number.isFinite(range.end) ? range.end : total, 0, total)),
  };
}

/** Snap one edge only when the resulting 30–60s range is still valid. */
export function snapClipEdge(
  edge: ClipEdge, value: number, range: ClipRange, boundaries: number[], duration: number,
): number {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const clamped = clampClipRange(range, total);
  const raw = round(clamp(Number.isFinite(value) ? value : 0, 0, total));
  if (total <= 0 || boundaries.length === 0) return raw;
  const snapped = nearestBoundary(raw, boundaries);
  if (Math.abs(snapped - raw) > 2) return raw;
  const next = edge === "start" ? { ...clamped, start: snapped } : { ...clamped, end: snapped };
  return clipRangeError(next, total) ? raw : snapped;
}

/**
 * Move one clip edge while keeping the other edge fixed.
 * The result always stays inside the source and the 30–60s clip window.
 * Optional visibleStart/visibleEnd keep a pointer drag inside the frozen
 * strip window; keyboard callers can omit them to use the whole source.
 */
export function constrainClipEdge(
  edge: ClipEdge, value: number, range: ClipRange, duration: number,
  visibleStart = 0, visibleEnd = duration,
): ClipRange {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (total <= 0) return range;
  const base = clampClipRange(range, total);
  const viewStart = clamp(Number.isFinite(visibleStart) ? visibleStart : 0, 0, total);
  const viewEnd = clamp(Number.isFinite(visibleEnd) ? visibleEnd : total, viewStart, total);
  const raw = round(Number.isFinite(value) ? value : base[edge]);

  if (edge === "start") {
    const lower = Math.max(0, base.end - CLIP_MAX_SECONDS, viewStart);
    const upper = Math.min(base.end - CLIP_MIN_SECONDS, viewEnd);
    if (lower > upper) return base;
    return { ...base, start: round(clamp(raw, lower, upper)) };
  }

  const lower = Math.max(base.start + CLIP_MIN_SECONDS, viewStart);
  const upper = Math.min(total, base.start + CLIP_MAX_SECONDS, viewEnd);
  if (lower > upper) return base;
  return { ...base, end: round(clamp(raw, lower, upper)) };
}

/** Translate a valid range without resizing it. Invalid drafts stay untouched. */
export function moveClipRange(
  range: ClipRange, delta: number, duration: number,
  visibleStart = 0, visibleEnd = duration,
): ClipRange {
  if (clipRangeError(range, duration) || !Number.isFinite(delta)) return range;
  const low = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
  const high = Math.min(duration, Number.isFinite(visibleEnd) ? visibleEnd : duration);
  const minDelta = low - range.start;
  const maxDelta = high - range.end;
  if (minDelta > maxDelta) return range;
  const shift = clamp(round(delta), minDelta, maxDelta);
  return { start: range.start + shift, end: range.end + shift };
}
