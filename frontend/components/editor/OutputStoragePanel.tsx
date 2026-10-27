"use client";

import { useState } from "react";
import { api, type OutputStorageInfo, type WorkCleanupItem, type WorkKind } from "@/lib/api";
import {
  formatBytes, formatMinAge, formatTrashExpiry, renderProtectionSummary, storageCategoryLabel,
  storageProtectionSummary, storageTrashLabel, storageUsageSummary, trashBatches,
  workProtectionSummary,
} from "@/lib/storage";
import styles from "./publishing.module.css";

type CleanupKind = "staging" | "renders";
type Selection = { tokens: string[]; files: string[]; work: string[] };

const workKey = (kind: WorkKind, name: string) => `${kind}:${name}`;

export default function OutputStoragePanel({ projectId, disabled, notify }: {
  projectId: string; disabled?: boolean; notify: (text: string, error?: boolean) => void;
}) {
  const [scanned, setScanned] = useState<{ projectId: string; data: OutputStorageInfo } | null>(null);
  const [pending, setPending] = useState<"scan" | CleanupKind | "work" | "selected" | "restore" | "empty" | null>(null);
  const [selected, setSelected] = useState<Selection>({ tokens: [], files: [], work: [] });
  const data = scanned?.projectId === projectId ? scanned.data : null;
  const minAge = formatMinAge(data?.min_age_seconds ?? 3600);
  const trashDays = formatMinAge(data?.trash.retention_seconds ?? 7 * 86400);
  const selectedTokens = data ? data.eligible.filter((item) => selected.tokens.includes(item.token)) : [];
  const selectedRenders = data ? data.renders.eligible.filter((item) => selected.files.includes(item.file)) : [];
  const selectedWork = data ? data.work.eligible.filter((item) =>
    selected.work.includes(workKey(item.kind, item.name))) : [];
  const selectionCount = selectedTokens.length + selectedRenders.length + selectedWork.length;
  const selectionBytes = selectedTokens.reduce((sum, item) => sum + item.bytes, 0) +
    selectedRenders.reduce((sum, item) => sum + item.bytes, 0) +
    selectedWork.reduce((sum, item) => sum + item.bytes, 0);
  const eligibleCount = data
    ? data.eligible.length + data.renders.eligible.length + data.work.eligible.length : 0;
  const allSelected = eligibleCount > 0 && selectionCount === eligibleCount;

  const refresh = async () => {
    const next = await api.outputStorage(projectId);
    setScanned({ projectId, data: next });
    setSelected({ tokens: [], files: [], work: [] });
  };

  const toggleToken = (token: string) => {
    setSelected((current) => ({
      ...current,
      tokens: current.tokens.includes(token)
        ? current.tokens.filter((value) => value !== token)
        : [...current.tokens, token],
    }));
  };

  const toggleFile = (file: string) => {
    setSelected((current) => ({
      ...current,
      files: current.files.includes(file)
        ? current.files.filter((value) => value !== file)
        : [...current.files, file],
    }));
  };

  const toggleWork = (key: string) => {
    setSelected((current) => ({
      ...current,
      work: current.work.includes(key)
        ? current.work.filter((value) => value !== key)
        : [...current.work, key],
    }));
  };

  const selectAll = () => {
    if (!data) return;
    setSelected(allSelected ? { tokens: [], files: [], work: [] } : {
      tokens: data.eligible.map((item) => item.token),
      files: data.renders.eligible.map((item) => item.file),
      work: data.work.eligible.map((item) => workKey(item.kind, item.name)),
    });
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

  const cleanWork = async () => {
    if (!data || data.work.eligible.length === 0) return;
    if (data.work_busy) {
      notify("Süren bir render, önizleme veya hazırlama işi var; iş bitince yeniden tarayın.", true);
      return;
    }
    const items: WorkCleanupItem[] = data.work.eligible.map((item) => ({ kind: item.kind, name: item.name }));
    if (!window.confirm(`${items.length} çalışma klasörü (${formatBytes(data.work.eligible_bytes)}) çöp kutusuna taşınsın mı?\n\n` +
      `Kaynak video, güncel render, önizlemeler ve proje verisi korunur. ` +
      `Seçilen çalışma klasörleri ${trashDays} boyunca geri alınabilir.`)) return;
    setPending("work");
    try {
      let trashed = 0;
      let moved = 0;
      let atRisk = 0;
      let firstError = "";
      for (let start = 0; start < items.length; start += 50) {
        try {
          const result = await api.cleanupWork(projectId, items.slice(start, start + 50));
          trashed += result.trashed.length;
          moved += result.moved_bytes;
          atRisk += result.failed.length + result.skipped.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      notify([
        `${trashed} çalışma klasörü çöp kutusuna taşındı · ${formatBytes(moved)} ${trashDays} içinde geri alınabilir.`,
        atRisk > 0 ? `${atRisk} öğe güvenlik denetimi nedeniyle atlandı.` : "",
        firstError ? `Bazı öğeler taşınamadı: ${firstError}` : "",
      ].filter(Boolean).join(" "), atRisk > 0 || !!firstError);
      try { await refresh(); } catch { setScanned(null); }
    } finally { setPending(null); }
  };

  const moveSelected = async () => {
    if (!data || selectionCount === 0) return;
    if ((selectedTokens.length > 0 && data.busy) || (selectedRenders.length > 0 && data.render_busy) ||
        (selectedWork.length > 0 && data.work_busy)) {
      notify("Süren bir işlem var; seçili öğeleri taşımak için iş bitince yeniden tarayın.", true);
      return;
    }
    const tokens = selectedTokens.map((item) => item.token);
    const files = selectedRenders.map((item) => item.file);
    const work: WorkCleanupItem[] = selectedWork.map((item) => ({ kind: item.kind, name: item.name }));
    const parts = [
      tokens.length > 0 ? `${tokens.length} hazırlama klasörü` : "",
      files.length > 0 ? `${files.length} ana render` : "",
      work.length > 0 ? `${work.length} çalışma klasörü` : "",
    ].filter(Boolean).join(" + ");
    if (!window.confirm(`Seçilen ${parts} (${formatBytes(selectionBytes)}) çöp kutusuna taşınsın mı?\n\n` +
      `Kaynak video, proje kapağı, güncel ana render, önizlemeler ve proje verisi korunur. ` +
      `Seçilenler ${trashDays} boyunca geri alınabilir.`)) return;
    setPending("selected");
    try {
      let trashed = 0;
      let moved = 0;
      let atRisk = 0;
      let firstError = "";
      for (let start = 0; start < tokens.length; start += 50) {
        try {
          const result = await api.cleanupOutputs(projectId, tokens.slice(start, start + 50));
          trashed += result.trashed.length;
          moved += result.moved_bytes;
          atRisk += result.failed.length + result.skipped.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      for (let start = 0; start < files.length; start += 50) {
        try {
          const result = await api.cleanupRenders(projectId, files.slice(start, start + 50));
          trashed += result.trashed.length;
          moved += result.moved_bytes;
          atRisk += result.failed.length + result.skipped.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      for (let start = 0; start < work.length; start += 50) {
        try {
          const result = await api.cleanupWork(projectId, work.slice(start, start + 50));
          trashed += result.trashed.length;
          moved += result.moved_bytes;
          atRisk += result.failed.length + result.skipped.length;
        } catch (e) {
          if (!firstError) firstError = (e as Error).message;
        }
      }
      notify([
        `${trashed} seçili öğe çöp kutusuna taşındı · ${formatBytes(moved)} ${trashDays} içinde geri alınabilir.`,
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
      önce oluşturulmuş ve kullanılmayan hazırlama klasörleri, eski ana render MP4&apos;leri ve work/ çalışma
      klasörleri çöpe taşınabilir. Bunlar hemen silinmez; {trashDays} boyunca çöp kutusunda tutulur. Kaynak medya,
      kapak, güncel ana render, önizlemeler ve proje verisi korunur.</p>
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
      {data && data.work.eligible.length > 0 && <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
        disabled={disabled || pending !== null || data.work_busy} onClick={cleanWork}>
        {pending === "work" ? "Taşınıyor…" : `${data.work.eligible.length} çalışma klasörünü çöpe taşı`}
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
      <p className={styles.note} role="status" aria-atomic="true">
        {data.work.eligible.length === 0
          ? "Çöpe taşınacak eski çalışma klasörü yok."
          : `${data.work.eligible.length} çalışma klasörü · ${formatBytes(data.work.eligible_bytes)} çöpe taşınabilir.`}
        {data.work.protected.length > 0
          ? ` ${data.work.protected.length} çalışma klasörü korunuyor (${workProtectionSummary(data.work.protected)}).`
          : ""}
      </p>
      {eligibleCount > 0 && <details className={styles.selection}>
        <summary>Tek tek seçerek temizle · {eligibleCount} uygun öğe</summary>
        <div className={styles.selectionBar}>
          <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
            disabled={disabled || pending !== null} onClick={selectAll}>
            {allSelected ? "Seçimi temizle" : "Tümünü seç"}
          </button>
          <span className={styles.selectionMeta}>{selectionCount} seçili · {formatBytes(selectionBytes)}</span>
        </div>
        {data.eligible.length > 0 && <fieldset className={styles.selectionGroup}>
          <legend>Hazırlama klasörleri</legend>
          <ul className={styles.selectionList}>
            {data.eligible.map((item) => <li key={item.token}>
              <label className={styles.selectionRow} title={item.token}>
                <input type="checkbox" checked={selected.tokens.includes(item.token)}
                  disabled={disabled || pending !== null} onChange={() => toggleToken(item.token)} />
                <span className={styles.selectionName}>{storageTrashLabel({ kind: "staging", name: item.token })}</span>
                <span className={styles.selectionAmount}>{formatBytes(item.bytes)}</span>
              </label>
            </li>)}
          </ul>
        </fieldset>}
        {data.renders.eligible.length > 0 && <fieldset className={styles.selectionGroup}>
          <legend>Ana render MP4&apos;leri</legend>
          <ul className={styles.selectionList}>
            {data.renders.eligible.map((item) => <li key={item.file}>
              <label className={styles.selectionRow} title={item.file}>
                <input type="checkbox" checked={selected.files.includes(item.file)}
                  disabled={disabled || pending !== null} onChange={() => toggleFile(item.file)} />
                <span className={styles.selectionName}>{storageTrashLabel({ kind: "render", name: item.file })}</span>
                <span className={styles.selectionAmount}>{formatBytes(item.bytes)}</span>
              </label>
            </li>)}
          </ul>
        </fieldset>}
        {data.work.eligible.length > 0 && <fieldset className={styles.selectionGroup}>
          <legend>Çalışma klasörleri</legend>
          <ul className={styles.selectionList}>
            {data.work.eligible.map((item) => {
              const key = workKey(item.kind, item.name);
              return <li key={key}>
                <label className={styles.selectionRow} title={item.name}>
                  <input type="checkbox" checked={selected.work.includes(key)}
                    disabled={disabled || pending !== null} onChange={() => toggleWork(key)} />
                  <span className={styles.selectionName}>{storageTrashLabel(item)}</span>
                  <span className={styles.selectionAmount}>{formatBytes(item.bytes)}</span>
                </label>
              </li>;
            })}
          </ul>
        </fieldset>}
        <div className={styles.actions}>
          <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
            disabled={disabled || pending !== null || selectionCount === 0 ||
              (selectedTokens.length > 0 && data.busy) || (selectedRenders.length > 0 && data.render_busy) ||
              (selectedWork.length > 0 && data.work_busy)}
            onClick={moveSelected}>
            {pending === "selected" ? "Taşınıyor…" : `Seçilenleri çöpe taşı · ${formatBytes(selectionBytes)}`}
          </button>
        </div>
      </details>}
      {data.busy && <p className={styles.note} role="status">Süren bir hazırlama işi var; güvenli temizlik için iş bitince yeniden tarayın.</p>}
      {data.render_busy && <p className={styles.note} role="status">Süren bir render veya hazırlama işi var; ana render temizliği için iş bitince yeniden tarayın.</p>}
      {data.work_busy && <p className={styles.note} role="status">Süren bir render, önizleme veya hazırlama işi var; çalışma klasörü temizliği için iş bitince yeniden tarayın.</p>}
      {data.trash.entries.length > 0 && <div className={styles.trash}>
        <div className={styles.trashHeading}>
          <h5>Çöp kutusu</h5>
          <span>{data.trash.entries.length} öğe · {formatBytes(data.trash.bytes)}</span>
        </div>
        <p className={styles.note}>{trashDays} içinde geri alınabilir; süre dolunca kalıcı silinir.</p>
        {trashBatches(data.trash.entries).map((batch, index) => <div className={styles.trashBatch} key={batch.id}>
          <div className={styles.trashBatchHeading}>
            <span>{index === 0 ? "Son temizlik" : "Önceki temizlik"} · {batch.entries.length} öğe · {formatBytes(batch.bytes)}</span>
            <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
              disabled={disabled || pending !== null} onClick={() => restore(batch.entries.map((entry) => entry.id))}>
              Bu grubu geri al
            </button>
          </div>
          <ul className={styles.trashEntries} aria-label={`${index === 0 ? "Son" : "Önceki"} temizlik öğeleri`}>
            {batch.entries.map((entry) => <li key={entry.id} className={styles.trashEntry}>
              <span className={styles.trashName}>
                <span title={entry.name}>{storageTrashLabel(entry)}</span>
                <small>{formatTrashExpiry(entry.expires_in_seconds)}</small>
              </span>
              <span className={styles.trashMeta}>{formatBytes(entry.bytes)}</span>
              <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
                disabled={disabled || pending !== null} onClick={() => restore([entry.id])}>Geri al</button>
            </li>)}
          </ul>
        </div>)}
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
