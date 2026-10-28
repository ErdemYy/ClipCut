import type { PreviewResult, Project, RenderOptions } from "./api";

/** Input freshness only: does not claim that the stored MP4 still exists on disk. */
export function mainRenderFreshness(project: Pick<Project, "output_url" | "output_meta" | "render_revision">) {
  if (!project.output_url) return "missing";
  const saved = project.output_meta?.render_revision;
  const current = project.render_revision;
  if (!saved || !current || !/^[a-f0-9]{64}$/.test(saved) || !/^[a-f0-9]{64}$/.test(current)) return "unknown";
  return saved === current ? "fresh" : "stale";
}

export function mainRenderMessage(project: Pick<Project, "output_url" | "output_meta" | "render_revision">) {
  const status = mainRenderFreshness(project);
  if (status === "stale") return "Bu çıktı mevcut düzenlemeleri içermiyor. Güncel dosya için yeniden render alın; önceki MP4 indirilebilir.";
  if (status === "unknown") return "Bu çıktının sürüm bilgisi yok; mevcut düzenlemelerle eşleştiği doğrulanamıyor. MP4 indirilebilir.";
  if (status === "fresh") return "Bu çıktı kayıtlı edit girdileriyle eşleşiyor.";
  return null;
}

/** Selection uses edited-output seconds, never the source player's clock. */
export function previewRange(start: number, duration: number, total: number) {
  const maxStart = Math.max(0, Math.floor((total - 0.1) * 1000) / 1000);
  const safeStart = Math.min(maxStart, Math.max(0, Number.isFinite(start) ? start : 0));
  return { start: safeStart, end: Math.min(total, safeStart + duration), maxStart };
}

export function previewIsStale(result: PreviewResult, revision: string | undefined, options: RenderOptions) {
  return !revision || result.render_revision !== revision || result.resolution !== options.resolution || result.quality !== options.quality;
}
