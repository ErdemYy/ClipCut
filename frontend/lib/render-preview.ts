import type { PreviewResult, RenderOptions } from "./api";

/** Selection uses edited-output seconds, never the source player's clock. */
export function previewRange(start: number, duration: number, total: number) {
  const maxStart = Math.max(0, Math.floor((total - 0.1) * 1000) / 1000);
  const safeStart = Math.min(maxStart, Math.max(0, Number.isFinite(start) ? start : 0));
  return { start: safeStart, end: Math.min(total, safeStart + duration), maxStart };
}

export function previewIsStale(result: PreviewResult, revision: string | undefined, options: RenderOptions) {
  return !revision || result.render_revision !== revision || result.resolution !== options.resolution || result.quality !== options.quality;
}
