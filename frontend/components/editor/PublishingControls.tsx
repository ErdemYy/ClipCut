"use client";

import { useId, useRef, useState } from "react";
import Image from "next/image";
import { downloadUrl, mediaUrl, formatTime, type FillMode, type Job, type PublishResult, type RenderOptions } from "@/lib/api";
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

export function PublishingResults({ job, freshness }: {
  job?: Job; freshness?: "stale" | "unknown";
}) {
  const previewId = useId();
  const previewAttempt = useRef(0);
  const [preview, setPreview] = useState<{ key: string; attempt: number; failed: boolean } | null>(null);
  if (job?.status === "failed") return <p className={styles.error} role="alert">{job.error || "Render başarısız. Yeniden deneyebilirsiniz."}</p>;
  if (job?.status !== "done" || !Array.isArray(job.result?.outputs)) return null;
  const result = job.result as unknown as PublishResult;
  return <section className={styles.results} aria-label="Hazır dosyalar">
    <h4>Dosyalar hazır</h4>
    {freshness && <p className={styles.stale} role="status">
      {freshness === "stale"
        ? "Aralık, kapak, seçim, format veya render ayarları son hazırlanan dosyalardan farklı. Dosyaları güncellemek için klipleri yeniden hazırlayın."
        : "Bu sonuç güncellik bilgisi olmadan hazırlandı. İndirmeden önce klipleri yeniden hazırlayarak güncel olduğunu doğrulayın."}
    </p>}
    <a className="btn btn-primary" href={downloadUrl(result.archive)} download>Tümünü ZIP olarak indir</a>
    <p className={styles.note}>Oynatıcıyı açarak hazırlanan dosyayı kontrol edin. Aynı anda tek çıktı açılır; video otomatik oynatılmaz. Bu, son hazırlanan dosyadır ve henüz uygulanmamış değişiklikleri içermez.</p>
    {result.outputs.map((out, index) => {
      const key = JSON.stringify([job.id, result.archive, out.output]);
      const opened = preview?.key === key;
      const attempt = opened ? preview.attempt : 0;
      const label = out.label.replaceAll("_", " ");
      const thumbnail = mediaUrl(out.thumbnail);
      const regionId = `${previewId}-${index}`;
      return <div className={styles.output} key={out.output}>
        <strong>{label}</strong>
        <small>{out.aspect_ratio} · {out.width} × {out.height} · {formatTime(out.duration)}</small>
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
    })}
  </section>;
}
