import type { ClipPreviewResult, ExportFormat, FillMode, RenderOptions } from "./api";
import type { ClipRange } from "./clip-trim";

export type ClipPreviewSelection = { start: number; duration: 5 | 10 };

/** Legacy results always previewed from zero; new results keep requested duration. */
export function clipPreviewSelection(result?: ClipPreviewResult | null): ClipPreviewSelection {
  return { start: result?.preview_start ?? 0,
    duration: result?.requested_duration ?? (result?.duration === 10 ? 10 : 5) };
}

export function clipPreviewWindow(range: ClipRange, selection: ClipPreviewSelection) {
  const length = range.end - range.start;
  const maxStart = Number.isFinite(length)
    ? Math.max(0, Math.floor((length - 0.1 + 1e-9) * 1000) / 1000) : 0;
  const valid = [range.start, range.end, selection.start].every(Number.isFinite)
    && range.start >= 0 && length > 0 && selection.start >= 0
    && (selection.duration === 5 || selection.duration === 10)
    && length - selection.start >= 0.1 - 1e-9;
  const duration = valid ? Math.min(selection.duration, length - selection.start) : 0;
  return { valid, maxStart, duration,
    sourceStart: range.start + selection.start,
    sourceEnd: range.start + selection.start + duration };
}

export function clipPreviewIsStale(result: ClipPreviewResult, range: ClipRange | undefined,
  selection: ClipPreviewSelection, options: RenderOptions, fill: FillMode, aspect: ExportFormat, revision?: string): boolean {
  const original = clipPreviewSelection(result);
  return !range || !clipPreviewWindow(range, selection).valid
    || range.start !== result.clip_start || range.end !== result.clip_end
    || selection.start !== original.start || selection.duration !== original.duration
    || options.resolution !== result.resolution || options.quality !== result.quality
    || fill !== result.fill || aspect !== result.aspect_ratio
    || !revision || revision !== result.render_revision;
}
