import type { ExportFormat, FillMode, PublishResult, RenderOptions } from "./api";

export type ClipExportInput = {
  analysisId: string;
  clips: { id: number; start: number; end: number; cover: number }[];
  aspects: ExportFormat[];
  fill: FillMode;
  options: RenderOptions;
  renderRevision?: string;
};

export type ClipExportFreshness = "fresh" | "stale" | "unknown";
export type ClipExportItemFreshness = ClipExportFreshness | "cover";
export const CLIP_ITEM_FRESHNESS_LABELS: Record<ClipExportItemFreshness, string> = {
  fresh: "Girdiler aynı", cover: "Yalnızca kapak yenilenecek",
  stale: "Yeniden hazırlanmalı", unknown: "Doğrulanamıyor",
};

// Server trims manual ranges to milliseconds; covers use the same precision so
// tiny floating-point roundoff cannot produce a false "stale" badge.
const sameTime = (rendered: number, current: number) =>
  Number.isFinite(rendered) && Number.isFinite(current) && Math.abs(rendered - current) < 0.0005;

export function clipExportFreshness(result: PublishResult, input: ClipExportInput): ClipExportFreshness {
  const request = result.clip_request;
  if (!request || !input.renderRevision) return "unknown";
  const requestAspects = request.aspect_ratios
    ?? (request.aspect_ratio ? [request.aspect_ratio] : []);
  if (requestAspects.length === 0) return "unknown";
  if (request.analysis_id !== input.analysisId
    || requestAspects.length !== input.aspects.length
    || requestAspects.some((format, index) => format !== input.aspects[index])
    || request.fill !== input.fill || request.resolution !== input.options.resolution
    || request.quality !== input.options.quality || request.render_revision !== input.renderRevision
    || request.clips.length !== input.clips.length) return "stale";
  return request.clips.some((rendered, index) => {
    const current = input.clips[index];
    return rendered.id !== current.id || !sameTime(rendered.start, current.start)
      || !sameTime(rendered.end, current.end) || !sameTime(rendered.cover_at, current.cover);
  }) ? "stale" : "fresh";
}

/** Per-clip input freshness ignores selection/format ordering; disk verification stays on the server.
 * "cover" means the MP4 can be kept and only the JPG needs a new frame. */
export function clipExportItemFreshness(result: PublishResult, input: ClipExportInput,
  clip: ClipExportInput["clips"][number]): ClipExportItemFreshness {
  const request = result.clip_request;
  if (!request || !input.renderRevision) return "unknown";
  if (request.analysis_id !== input.analysisId || request.render_revision !== input.renderRevision
    || request.fill !== input.fill || request.resolution !== input.options.resolution
    || request.quality !== input.options.quality) return "stale";
  const matches = request.clips.map((rendered, index) => ({ rendered, index })).filter(({ rendered }) => rendered.id === clip.id);
  if (matches.length === 0) return "stale";
  if (matches.length !== 1) return "unknown";
  const { rendered, index } = matches[0];
  if (!sameTime(rendered.start, clip.start) || !sameTime(rendered.end, clip.end)) return "stale";
  const coverMatches = sameTime(rendered.cover_at, clip.cover);
  const formats = request.aspect_ratios ?? (request.aspect_ratio ? [request.aspect_ratio] : []);
  if (!formats.length || !input.aspects.length) return "unknown";
  if (input.aspects.some((format) => !formats.includes(format))) return "stale";
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!hash(request.source_sha256) || !result.outputs.some((out) => Number.isInteger(out.clip_index))) return "unknown";
  let thumbnailUnknown = false;
  for (const format of input.aspects) {
    const pairs = result.outputs.filter((out) => out.clip_index === index + 1 && out.aspect_ratio === format);
    if (!pairs.length) return "stale";
    if (pairs.length !== 1 || !pairs[0].output || !pairs[0].thumbnail || !hash(pairs[0].sha256)) return "unknown";
    if (coverMatches && !hash(pairs[0].thumbnail_sha256)) thumbnailUnknown = true;
  }
  return coverMatches && !thumbnailUnknown ? "fresh" : "cover";
}
