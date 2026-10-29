import type { Project, TimelineInfo, Waveform } from "./api";

export const sourceReadKey = (project: Project) => JSON.stringify([project.id, project.source_url, project.duration, project.has_audio]);
export const timelineReadKey = (project: Project) => JSON.stringify([sourceReadKey(project), project.timeline_revision ?? project.plan]);

export function checkedTimeline(value: TimelineInfo, duration: number, revision?: string): TimelineInfo {
  if (revision && value.revision !== revision) throw new Error("Zaman çizelgesi proje sürümüyle eşleşmiyor; güncel projeyi yükleyin. Taslak korunuyor.");
  if (!Number.isFinite(value.source_duration) || Math.abs(value.source_duration - duration) > 0.001 ||
      !Number.isFinite(value.output_duration) || value.output_duration < 0 ||
      !Number.isFinite(value.speed) || value.speed <= 0 || !Number.isFinite(value.crossfade) || value.crossfade < 0 ||
      (value.exact_output_duration !== undefined && (!Number.isFinite(value.exact_output_duration) || value.exact_output_duration < 0)) ||
      !Array.isArray(value.segments) || value.segments.some((pair) => !Array.isArray(pair) || pair.length !== 2 ||
        pair.some((n) => !Number.isFinite(n)) || pair[0] < 0 || pair[1] < pair[0] || pair[1] > duration + 0.001)) {
    throw new Error("Zaman çizelgesi verisi geçersiz veya farklı kaynağa ait; yeniden yükleyin.");
  }
  return value;
}

export function checkedWaveform(value: Waveform, duration: number, hasAudio: boolean): Waveform {
  if (!Number.isFinite(value.duration) || Math.abs(value.duration - duration) > 0.001 || value.has_audio !== hasAudio ||
      !Array.isArray(value.peaks) || (value.has_audio && value.peaks.length === 0) ||
      value.peaks.some((peak) => !Number.isFinite(peak) || peak < 0 || peak > 1)) {
    throw new Error("Ses dalgası verisi geçersiz veya farklı kaynağa ait; yeniden yükleyin.");
  }
  return value;
}
