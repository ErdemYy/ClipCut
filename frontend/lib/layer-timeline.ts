import type { LayerTiming, Operation, TimelineInfo } from "./api";

export type TimelineLayer = LayerTiming & { type: "text" | "overlay"; label: string };
export type LayerGesture = "move" | "start" | "end";
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function timelineLayers(operations: Operation[]): TimelineLayer[] {
  return operations.flatMap((op, index) => op.type === "text" || op.type === "overlay" ? [{
    index, type: op.type, start: Number(op.start ?? 0), duration: Number(op.duration ?? 3),
    label: op.type === "text" ? String(op.text ?? "Metin") : String(op.label || op.track || "B-roll"),
  } as TimelineLayer] : []);
}

export function layerTimingError(layers: LayerTiming[], total: number): string | null {
  for (const layer of layers) {
    if (![layer.start, layer.duration].every(Number.isFinite) || layer.start < 0 || layer.duration < 0.1 || layer.duration > 600 || layer.start + layer.duration > total + 1e-6)
      return `Katman ${layer.index + 1}: başlangıç 0 veya üzeri, süre 0.1–600 sn olmalı; bitiş ${total.toFixed(3)} sn sınırını aşamaz.`;
  }
  return null;
}

export function adjustLayer(layer: LayerTiming, mode: LayerGesture, delta: number, total: number): LayerTiming {
  const minimum = Math.min(0.1, total);
  const duration = clamp(layer.duration, minimum, Math.min(600, total));
  let start = clamp(layer.start, 0, Math.max(0, total - duration));
  let end = start + duration;
  if (mode === "move") { start = clamp(start + delta, 0, total - duration); end = start + duration; }
  else if (mode === "start") start = clamp(start + delta, Math.max(0, end - 600), end - minimum);
  else end = clamp(end + delta, start + minimum, Math.min(total, start + 600));
  return { index: layer.index, start: round(start), duration: round(end - start) };
}

export function visibleLayer(layer: LayerTiming, total: number) {
  const start = clamp(layer.start, 0, total);
  const end = clamp(layer.start + layer.duration, 0, total);
  return end > start ? { left: start / total * 100, width: (end - start) / total * 100 } : null;
}

export function sourceToOutput(time: number, timeline: TimelineInfo): number | null {
  if (!Number.isFinite(time) || timeline.speed <= 0) return null;
  let offset = 0;
  for (const [index, [start, end]] of timeline.segments.entries()) {
    if (time >= start - 1e-6 && time <= end + 1e-6) return clamp((offset + time - start) / timeline.speed, 0, timeline.exact_output_duration ?? timeline.output_duration);
    offset += end - start - (index < timeline.segments.length - 1 ? timeline.crossfade : 0);
  }
  return null;
}

/** During a crossfade two source times overlap: choose the earlier/outgoing scene. */
export function outputToSource(time: number, timeline: TimelineInfo): number | null {
  if (!Number.isFinite(time) || time < 0 || time > (timeline.exact_output_duration ?? timeline.output_duration) || timeline.speed <= 0) return null;
  let offset = 0;
  for (const [index, [start, end]] of timeline.segments.entries()) {
    const local = time * timeline.speed - offset;
    if (local >= -1e-6 && local <= end - start + 1e-6) return clamp(start + local, start, end);
    offset += end - start - (index < timeline.segments.length - 1 ? timeline.crossfade : 0);
  }
  return null;
}
