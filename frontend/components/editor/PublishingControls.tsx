"use client";

import { useId, useRef, useState } from "react";
import Image from "next/image";
import { downloadUrl, mediaUrl, formatTime, type ExportFormat, type FillMode, type Job, type PublishResult, type RenderOptions } from "@/lib/api";
import { groupPublishedClips } from "@/lib/publishing-results";
import { CLIP_ITEM_FRESHNESS_LABELS, type ClipExportItemFreshness } from "@/lib/clip-export";
import styles from "./publishing.module.css";

export function RenderSettings({ value, onChange, fill, onFill, disabled }: {
  value: RenderOptions; onChange: (value: RenderOptions) => void; fill: FillMode;
  onFill: (value: FillMode) => void; disabled: boolean;
}) {
  return <fieldset className={styles.settings} disabled={disabled}>
    <legend>Render ayarları</legend>
    <label>Çözünürlük<select className="select" value={value.resolution}
      onChange={(e) => onChange({ ...value, resolution: e.target.value as RenderOptions["resolution"] })}>
      <option value="720p">720p · hızlı önizleme</option><option value="1080p">1080p · önerilen</option><option value="4k">4K · daha uzun render</option>
    </select></label>
    <label>Kalite<select className="select" value={value.quality}
      onChange={(e) => onChange({ ...value, quality: e.target.value as RenderOptions["quality"] })}>
      <option value="fast">Hızlı</option><option value="standard">Standart</option><option value="high">Yüksek</option>
    </select></label>
    <label>Kenar doldurma<select className="select" value={fill} onChange={(e) => onFill(e.target.value as FillMode)}>
      <option value="blur">Akıllı bulanık arka plan · görüntüyü koru</option>
      <option value="fit">Siyah kenar · görüntüyü koru</option><option value="crop">Merkezden kırp · kadrajı doldur</option>
    </select></label>
  </fieldset>;
}

export function PublishingResults({ job, freshness, clipEditors, clipRangeRestorers, clipFreshness }: {
  job?: Job; freshness?: "stale" | "unknown";
  clipEditors?: Record<number, () => void>;
  clipRangeRestorers?: Record<number, { current: { start: number; end: number }; restore: () => void }>;
  clipFreshness?: Record<number, ClipExportItemFreshness>;
}) {
  const previewId = useId();
  const previewAttempt = useRef(0);
  const [preview, setPreview] = useState<{ key: string; attempt: number; failed: boolean } | null>(null);
  const [formatFilter, setFormatFilter] = useState<{ key: string; format: ExportFormat | "all" } | null>(null);
  const [clipFormats, setClipFormats] = useState<{ key: string; values: Record<number, ExportFormat> } | null>(null);
  if (job?.status === "failed") return <p className={styles.error} role="alert">{job.error || "Render başarısız. Yeniden deneyebilirsiniz."}</p>;
  if (job?.status !== "done" || !Array.isArray(job.result?.outputs)) return null;
  const result = job.result as unknown as PublishResult;
  const resultKey = JSON.stringify([job.id, result.archive]);
  const formats = [...new Set(result.outputs.map((out) => out.aspect_ratio))];
  const selectedFormat = formatFilter?.key === resultKey && formats.includes(formatFilter.format as ExportFormat)
    ? formatFilter.format : "all";
  const shownOutputs = selectedFormat === "all" ? result.outputs
    : result.outputs.filter((out) => out.aspect_ratio === selectedFormat);
  const formatArchive = selectedFormat === "all" ? undefined : result.format_archives?.[selectedFormat];
  const filterHelpId = `${previewId}-filter-help`;
  const clipGroups = groupPublishedClips(result);
  const shownGroups = clipGroups?.map((group) => ({ ...group,
    outputs: group.outputs.filter((out) => selectedFormat === "all" || out.aspect_ratio === selectedFormat),
  })).filter((group) => group.outputs.length > 0);
  const reusedCount = result.reused_outputs;
  const renderedCount = result.rendered_outputs;
  const refreshedCount = result.refreshed_covers ?? 0;
  const countsValid = Number.isInteger(reusedCount) && Number.isInteger(renderedCount)
    && Number.isInteger(refreshedCount) && (reusedCount ?? -1) >= 0
    && (renderedCount ?? -1) >= 0 && refreshedCount >= 0
    && (reusedCount ?? 0) + (renderedCount ?? 0) + refreshedCount === result.outputs.length;
  const outputCard = (out: PublishResult["outputs"][number]) => {
    const key = JSON.stringify([job.id, result.archive, out.output]);
    const opened = preview?.key === key;
    const attempt = opened ? preview.attempt : 0;
    const label = out.label.replaceAll("_", " ");
    const thumbnail = mediaUrl(out.thumbnail);
    const regionId = `${previewId}-${result.outputs.indexOf(out)}`;
    return <div className={styles.output} key={out.output}>
      <strong>{label}</strong>
      <small>{out.aspect_ratio} · {out.width} × {out.height} · {formatTime(out.duration)}</small>
      {out.reused && <small>Önceki sonuçtan doğrulanarak korundu.</small>}
      {out.cover_refreshed && <small>MP4 önceki sonuçtan korundu; kapak JPG yeniden oluşturuldu.</small>}
      {typeof out.cover_at === "number" && <small>Kapak: klip içinde {out.cover_at.toFixed(1)} sn
        {typeof out.cover_source_at === "number" ? ` · kaynakta ${out.cover_source_at.toFixed(1)} sn` : ""}. JPG render edilmiş videodan alınır; zamanlama kare hassasiyetindedir.</small>}
      {!opened && thumbnail && <Image className={styles.outputPoster} src={thumbnail}
        width={out.width} height={out.height} unoptimized alt={`${label} kapak karesi`} />}
      <div className={styles.actions}>
        <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
          aria-expanded={opened} aria-controls={regionId} aria-label={`${label} oynatıcısını ${opened ? "kapat" : "aç"}`}
          onClick={() => setPreview(opened ? null : { key, attempt: ++previewAttempt.current, failed: false })}>
          {opened ? "Oynatıcıyı kapat" : "Oynatıcıyı aç"}
        </button>
        <a className="btn btn-sm" href={downloadUrl(out.output)} download>MP4 indir</a>
        <a className="btn btn-sm" href={downloadUrl(out.thumbnail)} download>Kapak JPG</a>
      </div>
      <div id={regionId} hidden={!opened}>
        {opened && (preview.failed ? <>
          <p className={styles.error} role="alert">Video yüklenemedi veya bu tarayıcıda oynatılamıyor. Yeniden deneyebilir ya da MP4 dosyasını indirebilirsiniz.</p>
          <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
            onClick={() => setPreview({ key, attempt: ++previewAttempt.current, failed: false })}>Oynatmayı yeniden dene</button>
        </> : <video key={`${key}:${attempt}`} controls playsInline preload="metadata"
          src={mediaUrl(out.output)} poster={mediaUrl(out.thumbnail)} aria-label={`${label} hazırlanmış videosu`}
          onError={() => setPreview((current) => current?.key === key && current.attempt === attempt
            ? { ...current, failed: true } : current)} />)}
      </div>
      {out.thumbnail_fallback && <small>Seçilen kaynak karesi kesildiği için ilk çıktı karesi kapak olarak kullanıldı.</small>}
    </div>;
  };
  return <section className={styles.results} aria-label="Hazır dosyalar">
    <h4>Dosyalar hazır</h4>
    {countsValid && <p className={styles.note} role="status" aria-atomic="true">
      {reusedCount} çıktı korundu{refreshedCount > 0 ? ` · ${refreshedCount} kapak yenilendi` : ""} · {renderedCount} çıktı yeniden hazırlandı.
    </p>}
    {freshness && <p className={styles.stale} role="status">
      {freshness === "stale"
        ? "Aralık, kapak, seçim, format veya render ayarları son hazırlanan dosyalardan farklı. Dosyaları güncellemek için klipleri yeniden hazırlayın."
        : "Bu sonuç güncellik bilgisi olmadan hazırlandı. İndirmeden önce klipleri yeniden hazırlayarak güncel olduğunu doğrulayın."}
    </p>}
    <a className="btn btn-primary" href={downloadUrl(result.archive)} download>Tümünü ZIP olarak indir</a>
    {formats.length > 1 && <fieldset className={styles.settings}>
      <legend>Sonuçları filtrele</legend>
      <label>Gösterilen format<select className={`select ${styles.trimShiftButton}`}
        value={selectedFormat} aria-describedby={filterHelpId} onChange={(e) => {
          const format = e.target.value as ExportFormat | "all";
          if (format !== "all" && !formats.includes(format)) return;
          setFormatFilter({ key: resultKey, format });
          setPreview(null);
        }}>
        <option value="all">Tüm formatlar</option>
        {formats.map((format) => <option key={format} value={format}>
          {format} · {result.outputs.filter((out) => out.aspect_ratio === format).length} çıktı
        </option>)}
      </select></label>
    </fieldset>}
    <p id={filterHelpId} className={styles.note} role="status" aria-atomic="true">
      {shownOutputs.length} / {result.outputs.length} {clipGroups ? "çıktı filtreyle eşleşiyor; her klip kartında bir format görüntülenir." : "çıktı gösteriliyor."} Tümünü ZIP bağlantısı bütün {result.outputs.length} çıktıyı içerir.
    </p>
    {selectedFormat !== "all" && (formatArchive
      ? <a className={`btn btn-sm ${styles.trimShiftButton}`} href={downloadUrl(formatArchive)} download>
        Yalnızca {selectedFormat} ZIP indir
      </a>
      : <p className={styles.note}>Bu sonuç için ayrı {selectedFormat} ZIP arşivi bulunmuyor. MP4/JPG bağlantılarını veya tüm çıktıları içeren ZIP dosyasını kullanabilirsiniz. Format arşivleri yeni hazırlanan sonuçlarda oluşturulur.</p>)}
    <p className={styles.note}>Oynatıcıyı açarak hazırlanan dosyayı kontrol edin. Aynı anda tek çıktı açılır; video otomatik oynatılmaz. Bu, son hazırlanan dosyadır ve henüz uygulanmamış değişiklikleri içermez.</p>
    {shownGroups ? shownGroups.map((group) => {
      const preferred = clipFormats?.key === resultKey ? clipFormats.values[group.clip_index] : undefined;
      const active = group.outputs.find((out) => out.aspect_ratio === preferred) ?? group.outputs[0];
      const groupId = `${previewId}-clip-${group.clip_index}`;
      const editClip = clipEditors?.[group.clip_index];
      const rangeRestore = clipRangeRestorers?.[group.clip_index];
      return <section key={group.clip_index} className={styles.clipGroup} aria-labelledby={`${groupId}-title`}>
        <h5 id={`${groupId}-title`}>Klip {group.clip_index}</h5>
        {clipFreshness?.[group.clip_index] && <p className={styles.note} role="status">
          Son çıktı: {CLIP_ITEM_FRESHNESS_LABELS[clipFreshness[group.clip_index]]}. Dosyalar yeniden kullanım öncesinde sunucuda doğrulanır.
        </p>}
        <p className={styles.note}>Kaynakta {formatTime(group.start)} – {formatTime(group.end)}. Klip ZIP dosyası, görünüm filtresinden bağımsız olarak bu klibin tüm formatlarını içerir.</p>
        <a className={`btn btn-sm ${styles.trimShiftButton}`} href={downloadUrl(group.archive)} download>
          Klip {group.clip_index} · tüm formatları ZIP indir
        </a>
        {editClip && <button type="button"
          className={`btn btn-sm ${styles.trimShiftButton}`} aria-label={`Klip ${group.clip_index} düzenleme alanına git`}
          onClick={() => { setPreview(null); editClip(); }}>Klibi düzenle</button>}
        {rangeRestore && <>
          <p className={styles.note}>Son render aralığı: {group.start.toFixed(3)} – {group.end.toFixed(3)} sn.
            {Number.isFinite(rangeRestore.current.start) && Number.isFinite(rangeRestore.current.end)
              ? ` Taslak aralığı: ${rangeRestore.current.start.toFixed(3)} – ${rangeRestore.current.end.toFixed(3)} sn.`
              : " Taslak aralığında geçersiz veya tamamlanmamış giriş var."}
            {" "}Yalnızca bu klibin zamanları geri yüklenir; seçim, kapak ve çıktı ayarları değişmez. Geçerli zaman değişiklikleri Aralık geri al ile korunur; geçersiz girişler geçmişe yazılmaz.</p>
          <button type="button" className={`btn btn-sm ${styles.trimShiftButton}`}
            aria-label={`Klip ${group.clip_index} son render aralığına dön`}
            onClick={() => { setPreview(null); rangeRestore.restore(); }}>Son render aralığına dön</button>
        </>}
        {group.outputs.length > 1 && <div className={styles.actions} role="group" aria-label={`Klip ${group.clip_index} formatı`}>
          {group.outputs.map((out) => <button type="button" key={out.output}
            className={`btn btn-sm ${styles.trimShiftButton} ${styles.formatButton}`}
            aria-pressed={out === active} aria-controls={`${groupId}-output`}
            aria-label={`Klip ${group.clip_index} ${out.aspect_ratio} formatını göster`}
            onClick={() => {
              if (out === active) return;
              setClipFormats((current) => ({ key: resultKey, values: {
                ...(current?.key === resultKey ? current.values : {}), [group.clip_index]: out.aspect_ratio,
              } }));
              setPreview(null);
            }}>{out.aspect_ratio}</button>)}
        </div>}
        <div id={`${groupId}-output`}>{outputCard(active)}</div>
      </section>;
    }) : shownOutputs.map(outputCard)}
  </section>;
}
