import type { ClipCandidate, ExportFormat, FillMode, RenderOptions } from "./api";
import { clipRangeError, type ClipRange } from "./clip-trim";
import { clipCoverError } from "./clip-cover";

export const CLIP_FORMATS: readonly ExportFormat[] = ["9:16", "1:1", "4:5", "16:9"];

export type ClipDraft = {
  ranges: Record<number, ClipRange>; selected: number[];
  options: RenderOptions; fill: FillMode; snap: boolean;
  covers: Record<number, number>; aspect: ExportFormat;
};

export const clipDraftStorageKey = (projectId: string) => `clipcut:clip-draft:v1:${projectId}`;

export function clipDraftContext(projectId: string, source: string | null, duration: number,
  hasAudio: boolean, analysisId: string, clips: ClipCandidate[]): string {
  return JSON.stringify([projectId, source, duration, hasAudio, analysisId,
    clips.map(({ id, start, end }) => [id, start, end])]);
}

export function defaultClipDraft(clips: ClipCandidate[]): ClipDraft {
  return { ranges: Object.fromEntries(clips.map(({ id, start, end }) => [id, { start, end }])),
    covers: Object.fromEntries(clips.map(({ id }) => [id, 0])),
    aspect: "9:16",
    selected: [], options: { resolution: "1080p", quality: "standard" }, fill: "blur", snap: true };
}

/** Local storage is untrusted: reject the entire snapshot rather than repair it. */
export function readClipDraft(raw: string | null, context: string, clips: ClipCandidate[], duration: number): ClipDraft | null {
  if (!raw || raw.length > 64000) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.context !== context) return null;
    const d = value.draft;
    if (!d || !d.ranges || typeof d.ranges !== "object" || Array.isArray(d.ranges)
      || !Array.isArray(d.selected) || typeof d.snap !== "boolean"
      || !["blur", "fit", "crop"].includes(d.fill)
      || !["720p", "1080p", "4k"].includes(d.options?.resolution)
      || !["fast", "standard", "high"].includes(d.options?.quality)) return null;
    const ids = new Set(clips.map((clip) => clip.id));
    if (Object.keys(d.ranges).length !== ids.size || new Set(d.selected).size !== d.selected.length
      || d.selected.some((id: unknown) => typeof id !== "number" || !ids.has(id))) return null;
    const ranges: Record<number, ClipRange> = {};
    const covers: Record<number, number> = {};
    const aspect = d.aspect === undefined ? "9:16" : d.aspect;
    if (!CLIP_FORMATS.includes(aspect)) return null;
    // Additive v1 migration: snapshots saved before cover selection start at zero.
    if (d.covers !== undefined && (!d.covers || typeof d.covers !== "object" || Array.isArray(d.covers)
      || Object.keys(d.covers).length !== ids.size)) return null;
    for (const clip of clips) {
      const range = d.ranges[clip.id];
      if (!range || clipRangeError(range, duration)) return null;
      ranges[clip.id] = { start: range.start, end: range.end };
      const cover = d.covers === undefined ? 0 : d.covers[clip.id];
      if (clipCoverError(cover, range)) return null;
      covers[clip.id] = cover;
    }
    return { ranges, covers, aspect, selected: [...d.selected], snap: d.snap, fill: d.fill,
      options: { resolution: d.options.resolution, quality: d.options.quality } };
  } catch { return null; }
}

export function serializeClipDraft(draft: ClipDraft, context: string, clips: ClipCandidate[], duration: number): string | null {
  const raw = JSON.stringify({ version: 1, context, draft });
  return readClipDraft(raw, context, clips, duration) ? raw : null;
}
