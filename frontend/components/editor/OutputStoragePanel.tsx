"use client";

import { useState } from "react";
import { api, type OutputStorageInfo } from "@/lib/api";
import {
  formatBytes, formatMinAge, renderProtectionSummary, storageCategoryLabel,
  storageProtectionSummary, storageTrashLabel, storageUsageSummary,
} from "@/lib/storage";
import styles from "./publishing.module.css";

type CleanupKind = "staging" | "renders";

export default function OutputStoragePanel({ projectId, disabled, notify }: {
  projectId: string; disabled?: boolean; notify: (text: string, error?: boolean) => void;
}) {
  const [scanned, setScanned] = useState<{ projectId: string; data: OutputStorageInfo } | null>(null);
  const [pending, setPending] = useState<"scan" | CleanupKind | "restore" | "empty" | null>(null);
  const data = scanned?.projectId === projectId ? scanned.data : null;
  const minAge = formatMinAge(data?.min_age_seconds ?? 3600);
  const trashDays = formatMinAge(data?.trash.retention_seconds ?? 7 * 86400);

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

  const clean = async (kind: CleanupKind) => {
    if (!data) return;
    const names = kind === "staging"
      ? data.eligible.map((item) => item.token)
      : data.renders.eligible.map((item) => item.file);
    if (names.length === 0) return;
    const bytes = kind === "staging" ? data.eligible_bytes : data.renders.eligible_bytes;
    const confirmed = kind === "staging"
      ? window.confirm(`${names.length} eski çıktı klasörü (${formatBytes(bytes)}) çöp kutusuna taşınsın mı?\n\n` +
        `Kaynak video, proje kapağı, ana render ve proje verisi korunur. Silinenler ${trashDays} boyunca geri alınabilir.`)
      : window.confirm(`${names.length} eski ana render MP4 (${formatBytes(bytes)}) çöp kutusuna taşınsın mı?\n\n` +
        `Güncel ana render, kaynak video, kapak, önizlemeler ve proje verisi korunur. ` +
        `Yalnızca proje durumunda veya başka bir iş sonucunda kullanılmayan eski render dosyaları taşınır; ${trashDays} boyunca geri alınabilir.`);
    if (!confirmed) return;
    setPending(kind);
    try {
      let trashed = 0;
      let moved = 0;
      let atRisk = 0;
      let firstError = "";
      // The API caps one confirmation at 50 items; keep large inventories safe.
      for (let start = 0; start < names.length; start += 50) {
        const batch = names.slice(start, start + 50);
        try {
          const result = kind === "staging"
            ? await api.cleanupOutputs(projectId, batch)
            : await api.cleanupRenders(projectId, batch);
          trashed += result.trashed.length;
          moved += result.moved_bytes;
          atRisk += result.failed.length + result.skipped.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      notify([
        `${trashed} ${kind === "staging" ? "klasör" : "ana render"} çöp kutusuna taşındı · ` +
          `${formatBytes(moved)} ${trashDays} içinde geri alınabilir.`,
        atRisk > 0 ? `${atRisk} öğe güvenlik denetimi nedeniyle atlandı.` : "",
        firstError ? `Bazı öğeler taşınamadı: ${firstError}` : "",
      ].filter(Boolean).join(" "), atRisk > 0 || !!firstError);
      try { await refresh(); } catch { setScanned(null); }
    } finally { setPending(null); }
  };

  const restore = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (ids.length > 1 && !window.confirm(`${ids.length} öğe çöp kutusundan geri alınsın mı?`)) return;
    setPending("restore");
    try {
      let restored = 0;
      let atRisk = 0;
      let firstError = "";
      for (let start = 0; start < ids.length; start += 50) {
        try {
          const result = await api.restoreTrash(projectId, ids.slice(start, start + 50));
          restored += result.restored.length;
          atRisk += result.skipped.length + result.failed.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      notify([
        `${restored} öğe geri alındı.`,
        atRisk > 0 ? `${atRisk} öğe geri alınamadı; yol dolu veya süre dolmuş olabilir.` : "",
        firstError ? `Geri alma hatası: ${firstError}` : "",
      ].filter(Boolean).join(" "), atRisk > 0 || !!firstError);
      try { await refresh(); } catch { setScanned(null); }
    } finally { setPending(null); }
  };

  const empty = async () => {
    if (!data || data.trash.entries.length === 0) return;
    if (!window.confirm(`${data.trash.entries.length} çöp öğesi (${formatBytes(data.trash.bytes)}) kalıcı olarak silinsin mi?\n\n` +
      "Bu işlem geri alınamaz. Güncel ana render, kaynak video, kapak, önizlemeler ve proje verisi korunur.")) return;
    setPending("empty");
    try {
      const result = await api.emptyTrash(projectId);
      notify(`${result.purged.length} çöp öğesi silindi · ${formatBytes(result.freed_bytes)} boşaltıldı.` +
        (result.failed.length > 0 ? ` ${result.failed.length} öğe silinemedi.` : ""), result.failed.length > 0);
      try { await refresh(); } catch { setScanned(null); }
    } catch (e) {
      notify((e as Error).message, true);
      try { await refresh(); } catch { setScanned(null); }
    } finally { setPending(null); }
  };

  return <section className={styles.storage} aria-label="Depolama">
    <h4>Depolama</h4>
    <p className={styles.note}>Projenin toplam disk kullanımını kategori bazında görün. Yalnızca en az {minAge}{" "}
      önce oluşturulmuş ve kullanılmayan hazırlama klasörleri ile eski ana render MP4&apos;leri çöpe taşınabilir.
      Bunlar hemen silinmez; {trashDays} boyunca çöp kutusunda tutulur. Kaynak medya, kapak, güncel ana render,
      önizlemeler ve proje verisi korunur.</p>
    <div className={styles.actions}>
      <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`} disabled={disabled || pending !== null} onClick={scan}>
        {pending === "scan" ? "Taranıyor…" : data ? "Depolamayı yeniden tara" : "Depolamayı tara"}
      </button>
      {data && data.eligible.length > 0 && <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
        disabled={disabled || pending !== null || data.busy} onClick={() => clean("staging")}>
        {pending === "staging" ? "Taşınıyor…" : `${data.eligible.length} eski çıktıyı çöpe taşı · ${formatBytes(data.eligible_bytes)}`}
      </button>}
      {data && data.renders.eligible.length > 0 && <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
        disabled={disabled || pending !== null || data.render_busy} onClick={() => clean("renders")}>
        {pending === "renders" ? "Taşınıyor…" : `${data.renders.eligible.length} eski ana render'ı çöpe taşı · ${formatBytes(data.renders.eligible_bytes)}`}
      </button>}
    </div>
    {data && <>
      <p className={styles.note} role="status" aria-atomic="true">
        {storageUsageSummary(data.total_bytes, data.reclaimable_bytes, data.trash.bytes)}
      </p>
      <ul className={styles.storageCategories} aria-label="Depolama kategorileri">
        {data.categories.map((category) => <li key={category.id} className={styles.storageCategory}>
          <span>{storageCategoryLabel(category.id)}</span>
          <span className={styles.storageAmount}>{formatBytes(category.bytes)}</span>
        </li>)}
      </ul>
      <p className={styles.note} role="status" aria-atomic="true">
        {data.eligible.length === 0
          ? "Çöpe taşınacak eski hazırlama klasörü yok."
          : `${data.eligible.length} klasör · ${formatBytes(data.eligible_bytes)} çöpe taşınabilir.`}
        {data.protected.length > 0 ? ` ${data.protected.length} klasör korunuyor (${storageProtectionSummary(data.protected)}).` : ""}
      </p>
      <p className={styles.note} role="status" aria-atomic="true">
        {data.renders.eligible.length === 0
          ? "Çöpe taşınacak eski ana render yok."
          : `${data.renders.eligible.length} ana render · ${formatBytes(data.renders.eligible_bytes)} çöpe taşınabilir.`}
        {data.renders.protected.length > 0
          ? ` ${data.renders.protected.length} ana render korunuyor (${renderProtectionSummary(data.renders.protected)}).`
          : ""}
      </p>
      {data.busy && <p className={styles.note} role="status">Süren bir hazırlama işi var; güvenli temizlik için iş bitince yeniden tarayın.</p>}
      {data.render_busy && <p className={styles.note} role="status">Süren bir render veya hazırlama işi var; ana render temizliği için iş bitince yeniden tarayın.</p>}
      {data.trash.entries.length > 0 && <div className={styles.trash}>
        <div className={styles.trashHeading}>
          <h5>Çöp kutusu</h5>
          <span>{data.trash.entries.length} öğe · {formatBytes(data.trash.bytes)}</span>
        </div>
        <p className={styles.note}>{trashDays} içinde geri alınabilir; süre dolunca kalıcı silinir.</p>
        <ul className={styles.trashEntries} aria-label="Çöp kutusundaki öğeler">
          {data.trash.entries.map((entry) => <li key={entry.id} className={styles.trashEntry}>
            <span className={styles.trashName} title={entry.name}>{storageTrashLabel(entry)}</span>
            <span className={styles.trashMeta}>{formatBytes(entry.bytes)}</span>
            <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
              disabled={disabled || pending !== null} onClick={() => restore([entry.id])}>Geri al</button>
          </li>)}
        </ul>
        <div className={styles.actions}>
          <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
            disabled={disabled || pending !== null} onClick={() => restore(data.trash.entries.map((entry) => entry.id))}>
            {pending === "restore" ? "Geri alınıyor…" : "Tümünü geri al"}
          </button>
          <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
            disabled={disabled || pending !== null} onClick={empty}>
            {pending === "empty" ? "Boşaltılıyor…" : `Çöp kutusunu boşalt · ${formatBytes(data.trash.bytes)}`}
          </button>
        </div>
      </div>}
    </>}
  </section>;
}
