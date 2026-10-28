import type { CostEstimate } from "./api";

/** Use a fresh server estimate immediately before the content-creation request. */
export function productionReviewText(estimate: CostEstimate, budget?: number): string {
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) throw new Error("Geçerli bir USD bütçe üst sınırı girin.");
  if (!estimate.mock && budget !== undefined && (estimate.estimated_usd === null || estimate.estimated_usd > budget + 1e-9)) {
    throw new Error(estimate.estimated_usd === null ? "Model fiyatı bilinmediği için bütçe doğrulanamıyor." : "Tahmini maliyet bütçenizi aşıyor; üretim başlatılmadı.");
  }
  return [
    "Üretim öncesi son kontrol",
    `Video modeli: ${estimate.video_model.label} (${estimate.video_model.id})`,
    `Metin modeli: ${estimate.text_model.label} (${estimate.text_model.id})`,
    `Video: ${estimate.video_calls} çağrı · ${estimate.video_seconds} saniye`,
    `Planlama: ${estimate.planning_calls} çağrı · Edge TTS: ${estimate.tts_calls} çağrı`,
    `Tahmini tutar: ${estimate.mock ? "$0 (test sağlayıcısı)" : estimate.estimated_usd === null ? "Bilinmiyor" : `$${estimate.estimated_usd.toFixed(4)}`}`,
    `Bütçe üst sınırı: ${budget === undefined ? "Belirtilmedi" : `$${budget.toFixed(4)}`}`,
    ...estimate.warnings,
    "Tahmin kesin fatura değildir; sağlayıcıda başlamış istekler başarısız olsa da ücretlenebilir.",
    "Prompt ve varsa anlatım metni ilgili sağlayıcıya gönderilir. Başlatılsın mı?",
  ].join("\n\n");
}

export function approveProduction(estimate: CostEstimate, budget?: number,
  confirm: (message: string) => boolean = (message) => window.confirm(message)): boolean {
  const message = productionReviewText(estimate, budget);
  if (estimate.mock || (estimate.video_calls === 0 && estimate.planning_calls === 0 && estimate.tts_calls === 0)) return true;
  return confirm(message);
}
