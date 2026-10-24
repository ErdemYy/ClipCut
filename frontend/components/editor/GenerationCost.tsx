"use client";

import { useEffect, useId, useState } from "react";
import { api, type CostEstimate, type ModelCatalog } from "@/lib/api";
import styles from "./generation-cost.module.css";

type Props = {
  catalog: ModelCatalog | null;
  videoModel: string;
  textModel: string;
  onVideoModel?: (id: string) => void;
  onTextModel?: (id: string) => void;
  sceneDurations?: number[];
  planningSceneCount?: number;
  planningChars?: number;
  voiceover?: boolean;
  budget?: string;
  onBudget?: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  showBudget?: boolean;
};

const statusLabel: Record<string, string> = {
  active: "etkin",
  deprecated: "deprecated",
  closed: "kapatıldı",
  unpriced: "fiyat bilinmiyor",
};

const dollars = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `$${value.toFixed(4)}`;

export default function GenerationCost(props: Props) {
  const { catalog, videoModel, textModel, onVideoModel, onTextModel, sceneDurations = [], planningSceneCount = 0,
    planningChars = 0, voiceover = false, budget = "", onBudget, disabled = false, compact = false,
    showBudget = true } = props;
  const [loaded, setLoaded] = useState<{ key: string; estimate?: CostEstimate; error?: string } | null>(null);
  const budgetId = useId();
  const durationsKey = sceneDurations.join(",");
  const key = JSON.stringify([videoModel, textModel, durationsKey, planningSceneCount, planningChars, voiceover]);
  const video = catalog?.video.find((model) => model.id === videoModel);
  const text = catalog?.text.find((model) => model.id === textModel);
  const limit = budget.trim() === "" ? null : Number(budget);

  useEffect(() => {
    if (!catalog) return;
    const controller = new AbortController();
    api.preflight({
      video_model: videoModel, text_model: textModel,
      scene_durations: durationsKey === "" ? [] : durationsKey.split(",").map(Number),
      voiceover, planning_scene_count: planningSceneCount, planning_chars: planningChars,
    }).then((estimate) => {
      if (!controller.signal.aborted) setLoaded({ key, estimate });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setLoaded({ key, error: error.message });
    });
    return () => controller.abort();
  }, [catalog, key, videoModel, textModel, durationsKey, voiceover, planningSceneCount, planningChars]);

  const estimate = loaded?.key === key ? loaded.estimate : undefined;
  const error = loaded?.key === key ? loaded.error : undefined;
  const overBudget = !!(estimate && limit !== null && Number.isFinite(limit) && estimate.estimated_usd !== null
    && estimate.estimated_usd > limit + 1e-9);
  const unpricedAgainstBudget = !!(estimate && limit !== null && !estimate.mock && estimate.estimated_usd === null);

  return <section className={styles.cost} aria-labelledby={`${budgetId}-title`}>
    <header className={styles.head}>
      <h4 id={`${budgetId}-title`}>Model ve maliyet</h4>
      <span className={styles.badge}>{catalog?.mock ? "Demo · ücretsiz" : "Tahmini liste fiyatı"}</span>
    </header>
    <div className={styles.models}>
      {onVideoModel && <label>Video modeli
        <select className="select" value={videoModel} disabled={disabled || !catalog}
          onChange={(event) => onVideoModel(event.target.value)}>
          {(catalog?.video ?? []).map((model) => <option key={model.id} value={model.id}>
            {model.label} · {statusLabel[model.status]} · {model.durations.join("/")} sn
          </option>)}
        </select>
      </label>}
      {onTextModel && <label>Metin/planlama modeli
        <select className="select" value={textModel} disabled={disabled || !catalog}
          onChange={(event) => onTextModel(event.target.value)}>
          {(catalog?.text ?? []).map((model) => <option key={model.id} value={model.id}>
            {model.label} · {statusLabel[model.status]}
          </option>)}
        </select>
      </label>}
    </div>
    {!compact && (video?.note || text?.note) && <p className={styles.warn}>{video?.note || text?.note}</p>}
    {error && <p className={styles.error} role="alert">Maliyet tahmini alınamadı: {error}</p>}
    {!error && !estimate && <p className={styles.note} role="status">Maliyet tahmini hazırlanıyor…</p>}
    {estimate && <div className={styles.estimate} aria-live="polite">
      <ul>
        {estimate.components.map((component) => <li key={component.label}>
          <span>{component.label} · <small>{component.detail}</small></span>
          <strong>{estimate.mock ? "ücretsiz" : dollars(component.usd)}</strong>
        </li>)}
        {!estimate.components.length && <li><span>Henüz üretim çağrısı planlanmadı.</span><strong>$0.0000</strong></li>}
      </ul>
      <p className={styles.total}>Tahmini toplam: <strong>{estimate.mock ? "ücretsiz" : dollars(estimate.estimated_usd)}</strong></p>
      {!estimate.priced && !estimate.mock && <p className={styles.warn} role="alert">Bazı modellerin fiyatı bilinmiyor; toplam tahmin üretilemez ve bütçe doğrulanamaz.</p>}
      {estimate.warnings.map((warning) => <p key={warning} className={styles.warn}>{warning}</p>)}
      <details className={styles.note}>
        <summary>Fiyat notu · {estimate.pricing_read_at}</summary>
        <p>{estimate.pricing_note}</p>
      </details>
    </div>}
    {showBudget && onBudget && <>
      <label htmlFor={budgetId} className={styles.budget}>Bütçe üst sınırı (USD, isteğe bağlı)
        <input id={budgetId} className="input" type="number" min="0" max="10000" step="0.01" inputMode="decimal"
          placeholder="Sınır yok" value={budget} disabled={disabled}
          onChange={(event) => onBudget(event.target.value)} aria-describedby={`${budgetId}-help`} />
      </label>
      <p className={styles.note} id={`${budgetId}-help`}>Sunucu, sağlayıcı çağrısından önce tahmini yeniden hesaplar. Sınır aşılırsa hiçbir AI isteği başlatılmaz. Yine de sağlayıcı faturası kesin değildir; başarısız/iptal istekler ücretlenebilir.</p>
    </>}
    {showBudget && onBudget && (overBudget || unpricedAgainstBudget) && <p className={styles.error} role="alert">
      {unpricedAgainstBudget ? "Fiyatı bilinmeyen modelle bütçe doğrulanamaz." :
        `Tahmini ${dollars(estimate?.estimated_usd)} tutar, ${dollars(limit)} bütçesini aşıyor. Üretim engellenecek.`}
    </p>}
  </section>;
}
