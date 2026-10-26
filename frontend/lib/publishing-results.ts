import type { PublishResult } from "./api";

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
