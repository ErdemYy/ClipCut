"use client";

import { useState } from "react";
import { api, type OutputStorageInfo } from "@/lib/api";
import { formatBytes, formatMinAge, storageProtectionSummary } from "@/lib/storage";
import styles from "./publishing.module.css";

export default function OutputStoragePanel({ projectId, disabled, notify }: {
  projectId: string; disabled?: boolean; notify: (text: string, error?: boolean) => void;
}) {
  const [scanned, setScanned] = useState<{ projectId: string; data: OutputStorageInfo } | null>(null);
  const [pending, setPending] = useState<"scan" | "clean" | null>(null);
  const data = scanned?.projectId === projectId ? scanned.data : null;
  const minAge = formatMinAge(data?.min_age_seconds ?? 3600);

  const refresh = async () => {
    const next = await api.outputStorage(projectId);
    setScanned({ projectId, data: next });
  };

  const scan = async () => {
    setPending("scan");
    try { await refresh(); }
    catch (e) { notify((e as Error).message, true); }
    finally { setPending(null); }
  };

  const clean = async () => {
    if (!data || data.busy || data.eligible.length === 0) return;
    const tokens = data.eligible.map((item) => item.token);
    if (!window.confirm(`${tokens.length} eski çıktı klasörü (${formatBytes(data.eligible_bytes)}) silinsin mi?\n\n` +
      "Kaynak video, proje kapağı, ana render ve proje verisi korunur. " +
      "Yalnızca hazırlama çıktıları silinir; bu işlem geri alınamaz.")) return;
    setPending("clean");
    try {
      let deleted = 0;
      let freed = 0;
      let atRisk = 0;
      let firstError = "";
      // The API caps one confirmation at 50 tokens; keep large inventories safe.
      for (let start = 0; start < tokens.length; start += 50) {
        try {
          const result = await api.cleanupOutputs(projectId, tokens.slice(start, start + 50));
          deleted += result.deleted.length;
          freed += result.freed_bytes;
          atRisk += result.failed.length + result.skipped.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      notify([
        `${deleted} klasör silindi · ${formatBytes(freed)} boşaltıldı.`,
        atRisk > 0 ? `${atRisk} klasör güvenlik denetimi nedeniyle atlandı.` : "",
        firstError ? `Bazı klasörler silinemedi: ${firstError}` : "",
      ].filter(Boolean).join(" "), atRisk > 0 || !!firstError);
      try { await refresh(); } catch { setScanned(null); }
    } finally { setPending(null); }
  };

  return <section className={styles.storage} aria-label="Eski çıktı depolaması">
    <h4>Depolama</h4>
    <p className={styles.note}>Yalnızca hiçbir iş sonucunda kullanılmayan, en az {minAge} önce oluşturulmuş ve
      yalnızca normal dosyalardan oluşan hazırlama klasörleri silinebilir. Kaynak video, proje kapağı,
      ana render ve proje verisi korunur. İşlem geri alınamaz.</p>
    <div className={styles.actions}>
      <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`} disabled={disabled || pending !== null} onClick={scan}>
        {pending === "scan" ? "Taranıyor…" : data ? "Depolamayı yeniden tara" : "Depolamayı tara"}
      </button>
      {data && data.eligible.length > 0 && <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
        disabled={disabled || pending !== null || data.busy} onClick={clean}>
        {pending === "clean" ? "Temizleniyor…" : `${data.eligible.length} eski çıktıyı temizle · ${formatBytes(data.eligible_bytes)}`}
      </button>}
    </div>
    {data && <>
      <p className={styles.note} role="status" aria-atomic="true">
        {data.eligible.length === 0
          ? "Temizlenecek eski çıktı klasörü yok."
          : `${data.eligible.length} klasör · ${formatBytes(data.eligible_bytes)} temizlenebilir.`}
        {data.protected.length > 0 ? ` ${data.protected.length} klasör korunuyor (${storageProtectionSummary(data.protected)}).` : ""}
      </p>
      {data.busy && <p className={styles.note} role="status">Süren bir hazırlama işi var; güvenli temizlik için iş bitince yeniden tarayın.</p>}
    </>}
  </section>;
}
