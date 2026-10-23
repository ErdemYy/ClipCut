import type { StoryScene } from "./api";

export const MIN_SCENE_LENGTH = 0.25;
export const MAX_TRANSITION = 2;
export const MIN_TRANSITION = 0.2;

export function sceneBounds(scene: StoryScene, runtime?: StoryScene) {
  const available = runtime?.actual_duration ?? scene.actual_duration ?? scene.duration;
  const start = Math.max(0, Math.min(scene.trim_start ?? 0, available - MIN_SCENE_LENGTH));
  const end = Math.max(start + MIN_SCENE_LENGTH, Math.min(scene.trim_end ?? available, available));
  return { available, start, end, length: end - start };
}

/** Effective overlap; mirrors backend `transition_overlap` so the draft timeline matches the merge. */
export function transitionOverlap(previousLength: number, currentLength: number, scene: StoryScene) {
  if (scene.transition !== "dissolve" && scene.transition !== "fade") return 0;
  const requested = Number(scene.transition_duration);
  if (!Number.isFinite(requested)) return 0;
  const overlap = Math.min(requested, MAX_TRANSITION, previousLength * 0.4, currentLength * 0.4);
  return overlap >= MIN_TRANSITION ? Math.round(overlap * 1000) / 1000 : 0;
}

export function sceneLayout(scenes: StoryScene[], runtime: StoryScene[]) {
  const bounds = scenes.map((scene) => ({ scene, state: runtime.find((s) => s.id === scene.id), ...sceneBounds(scene, runtime.find((s) => s.id === scene.id)) }));
  const incoming = bounds.map((item, i) => i ? transitionOverlap(bounds[i - 1].length, item.length, item.scene) : 0);
  let offset = 0;
  return bounds.map((item, i) => {
    const entry = {
      ...item, offset, incoming: incoming[i],
      // Each overlap is shared by both neighbours, so halve it when sizing the distribution bar.
      weight: Math.max(0.01, item.length - incoming[i] / 2 - (incoming[i + 1] ?? 0) / 2),
    };
    offset += item.length - (incoming[i + 1] ?? 0);
    return entry;
  });
}

export function reorderScenes(scenes: StoryScene[], source: string, target: string, side: "before" | "after") {
  if (source === target || !scenes.some((s) => s.id === source) || !scenes.some((s) => s.id === target)) return scenes;
  const moving = scenes.find((s) => s.id === source)!;
  const next = scenes.filter((s) => s.id !== source);
  next.splice(next.findIndex((s) => s.id === target) + (side === "after" ? 1 : 0), 0, moving);
  return next;
}

export function timelineDuration(items: { offset: number; length: number }[]) {
  const last = items[items.length - 1];
  return last ? last.offset + last.length : 0;
}
