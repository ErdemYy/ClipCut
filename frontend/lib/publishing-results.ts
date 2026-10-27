import type { ClipCandidate, PublishResult } from "./api";
import { clipRangeError, type ClipRange } from "./clip-trim";

export type ClipOutputGroup = NonNullable<PublishResult["clip_archives"]>[number] & {
  outputs: PublishResult["outputs"];
};

/** Only explicit, complete metadata may group outputs; never infer clips from labels. */
export function groupPublishedClips(result: PublishResult): ClipOutputGroup[] | null {
  if (!Array.isArray(result.clip_archives) || !result.clip_archives.length) return null;
  const groups = new Map<number, ClipOutputGroup>();
  for (const entry of result.clip_archives) {
    if (!entry || !Number.isInteger(entry.clip_index) || entry.clip_index < 1
      || groups.has(entry.clip_index) || !Number.isFinite(entry.start) || !Number.isFinite(entry.end)
      || entry.start < 0 || entry.end <= entry.start || typeof entry.archive !== "string" || !entry.archive)
      return null;
    groups.set(entry.clip_index, { ...entry, outputs: [] });
  }
  for (const out of result.outputs) {
    const group = out.clip_index === undefined ? undefined : groups.get(out.clip_index);
    if (!group || group.outputs.some((item) => item.aspect_ratio === out.aspect_ratio)) return null;
    group.outputs.push(out);
  }
  return [...groups.values()].every((group) => group.outputs.length > 0) ? [...groups.values()] : null;
}

/** Match export ordinals to current candidate IDs, not current selection order. */
export function editablePublishedClipIds(result: PublishResult, analysisId: string | undefined,
  candidates: readonly Pick<ClipCandidate, "id">[]): Record<number, number> {
  const groups = groupPublishedClips(result);
  const request = result.clip_request;
  if (!groups || !analysisId || request?.analysis_id !== analysisId
    || !Array.isArray(request.clips) || request.clips.length !== groups.length) return {};
  const currentIds = new Set(candidates.map((candidate) => candidate.id));
  const seen = new Set<number>();
  const targets: Record<number, number> = {};
  for (const group of groups) {
    const rendered = request.clips[group.clip_index - 1];
    if (!rendered || !Number.isInteger(rendered.id) || rendered.id < 0 || seen.has(rendered.id)
      || !currentIds.has(rendered.id) || rendered.start !== group.start || rendered.end !== group.end) return {};
    seen.add(rendered.id);
    targets[group.clip_index] = rendered.id;
  }
  return targets;
}

export type PublishedClipRangeRestore = { id: number; current: ClipRange; rendered: ClipRange };

/** Restore timing only when the analysis, revision and source bounds still match. */
export function publishedClipRangeRestores(result: PublishResult, analysisId: string | undefined,
  candidates: readonly (Pick<ClipCandidate, "id"> & ClipRange)[], duration: number,
  revision: string | undefined): Record<number, PublishedClipRangeRestore> {
  if (!revision || result.clip_request?.render_revision !== revision) return {};
  const ids = editablePublishedClipIds(result, analysisId, candidates);
  const restores: Record<number, PublishedClipRangeRestore> = {};
  for (const [index, id] of Object.entries(ids)) {
    const clip = result.clip_request.clips[Number(index) - 1];
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate) continue;
    const rendered = { start: clip.start, end: clip.end };
    if (clipRangeError(rendered, duration)
      || (candidate.start === rendered.start && candidate.end === rendered.end)
      || candidates.some((other) => other.id !== id && clipRangeError(other, duration))) continue;
    restores[Number(index)] = { id, rendered, current: { start: candidate.start, end: candidate.end } };
  }
  return restores;
}
