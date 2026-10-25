import type { ExportFormat, FillMode, PublishResult, RenderOptions } from "./api";

export type ClipExportInput = {
  analysisId: string;
  clips: { id: number; start: number; end: number; cover: number }[];
  aspect: ExportFormat;
  fill: FillMode;
  options: RenderOptions;
  renderRevision?: string;
};

export type ClipExportFreshness = "fresh" | "stale" | "unknown";

// Server trims manual ranges to milliseconds; covers use the same precision so
// tiny floating-point roundoff cannot produce a false "stale" badge.
const sameTime = (rendered: number, current: number) =>
  Number.isFinite(rendered) && Number.isFinite(current) && Math.abs(rendered - current) < 0.0005;

export function clipExportFreshness(result: PublishResult, input: ClipExportInput): ClipExportFreshness {
  const request = result.clip_request;
  if (!request || !input.renderRevision) return "unknown";
  if (request.analysis_id !== input.analysisId || request.aspect_ratio !== input.aspect
    || request.fill !== input.fill || request.resolution !== input.options.resolution
    || request.quality !== input.options.quality || request.render_revision !== input.renderRevision
    || request.clips.length !== input.clips.length) return "stale";
  return request.clips.some((rendered, index) => {
    const current = input.clips[index];
    return rendered.id !== current.id || !sameTime(rendered.start, current.start)
      || !sameTime(rendered.end, current.end) || !sameTime(rendered.cover_at, current.cover);
  }) ? "stale" : "fresh";
}
