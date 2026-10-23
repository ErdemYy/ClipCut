"use client";

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

export function PublishingResults({ job }: { job?: Job }) {
  if (job?.status === "failed") return <p className={styles.error} role="alert">{job.error || "Render başarısız. Yeniden deneyebilirsiniz."}</p>;
  if (job?.status !== "done" || !Array.isArray(job.result?.outputs)) return null;
  const result = job.result as unknown as PublishResult;
  return <section className={styles.results} aria-label="Hazır dosyalar">
    <h4>Dosyalar hazır</h4>
    <a className="btn btn-primary" href={downloadUrl(result.archive)} download>Tümünü ZIP olarak indir</a>
    {result.outputs.map((out) => <div className={styles.output} key={out.output}>
      <strong>{out.label.replaceAll("_", " ")}</strong>
      <small>{out.aspect_ratio} · {out.width} × {out.height} · {formatTime(out.duration)}</small>
      <video controls preload="none" src={mediaUrl(out.output)} poster={mediaUrl(out.thumbnail)} aria-label={`${out.label} önizlemesi`} />
      <div className={styles.actions}>
        <a className="btn btn-sm" href={downloadUrl(out.output)} download>MP4 indir</a>
        <a className="btn btn-sm" href={downloadUrl(out.thumbnail)} download>Kapak JPG</a>
      </div>
      {out.thumbnail_fallback && <small>Seçilen kaynak karesi kesildiği için ilk çıktı karesi kapak olarak kullanıldı.</small>}
    </div>)}
  </section>;
}
