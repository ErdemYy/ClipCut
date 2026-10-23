"use client";

import { useRef, useState } from "react";
import { api, downloadUrl, formatTime, mediaUrl, type ExportFormat, type FillMode, type Job, type JobMap, type Project, type RenderOptions } from "@/lib/api";
import { JobProgress } from "./SubtitlePanel";
import { PublishingResults, RenderSettings } from "./PublishingControls";
import styles from "./editor-parts.module.css";
import pub from "./publishing.module.css";

const FORMATS: { id: ExportFormat; name: string; hint: string }[] = [
  { id: "9:16", name: "TikTok / Reels / Shorts", hint: "Dikey · 1080 × 1920" },
  { id: "1:1", name: "Instagram Post", hint: "Kare · 1080 × 1080" },
  { id: "4:5", name: "Instagram Post", hint: "Portre · 1080 × 1350" },
  { id: "16:9", name: "YouTube", hint: "Yatay · 1920 × 1080" },
];

type Props = {
  project: Project; jobs: JobMap; setProject: (p: Project) => void;
  track: (job: Job, onDone?: (job: Job) => void) => Promise<void>;
  notify: (t: string, e?: boolean) => void; onRendered: () => void;
};

export default function ExportPanel({ project, jobs, setProject, track, notify, onRendered }: Props) {
  const [formats, setFormats] = useState<ExportFormat[]>(FORMATS.map((f) => f.id));
  const [options, setOptions] = useState<RenderOptions>({ resolution: "1080p", quality: "standard" });
  const [fill, setFill] = useState<FillMode>("blur");
  const [at, setAt] = useState(0);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const batch = jobs.export_batch;
  const running = [jobs.render, batch].find((j) => j?.status === "queued" || j?.status === "running");
  const disabled = pending || !!running || project.status !== "ready";

  const start = async (single = false) => {
    setPending(true);
    try {
      const j = single ? await api.render(project.id, options) : await api.exportBatch(project.id, { ...options, formats, fill, thumbnail_at: at });
      await track(j, () => { notify(single ? "Render tamamlandı." : "Tüm formatlar hazır; ZIP dosyasını indirebilirsiniz."); if (single) onRendered(); });
    } catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };

  const saveCover = async () => {
    setSaving(true);
    try { setProject(await api.selectThumbnail(project.id, at)); notify("Proje kapağı kaydedildi."); }
    catch (e) { notify((e as Error).message, true); }
    finally { setSaving(false); }
  };

  return <div className={styles.section}>
    <header className={pub.intro}>
      <h3>Çoklu format dışa aktar</h3>
      <p>Seçtiğiniz formatlar mevcut edit planıyla sırayla render edilir. Bulanık kenar doldurma, görüntüyü kesmeden kadrajı tamamlar.</p>
    </header>
    <fieldset className={pub.formats} disabled={disabled}>
      <legend>Platformlar · {formats.length} format</legend>
      {FORMATS.map((f) => <label key={f.id}>
        <input type="checkbox" checked={formats.includes(f.id)} onChange={(e) => setFormats((current) => e.target.checked ? [...current, f.id] : current.filter((v) => v !== f.id))} />
        <span>{f.name} · {f.id}<small>{f.hint} (1080p)</small></span>
      </label>)}
    </fieldset>
    <RenderSettings value={options} onChange={setOptions} fill={fill} onFill={setFill} disabled={disabled} />
    <section className={pub.cover} aria-label="Kapak karesi seçici">
      <h4>Kapak karesi</h4>
      <video ref={video} src={mediaUrl(project.source_url)} controls muted playsInline preload="metadata"
        onTimeUpdate={(e) => setAt(Math.min(e.currentTarget.currentTime, Math.max(0, project.duration - 0.1)))} aria-label="Kaynak videodan kapak seç" />
      <label>Kaynak zamanı · {formatTime(at)} ({at.toFixed(1)} sn)
        <input type="range" min="0" max={Math.max(0, project.duration - 0.1)} step="0.1" value={at} disabled={disabled || saving}
          onChange={(e) => { const t = Number(e.target.value); setAt(t); if (video.current) { video.current.pause(); video.current.currentTime = t; } }} />
      </label>
      <p className={pub.note}>Seçilen kare her formatın işlenmiş zaman çizelgesine eşlenir. Kare editte kesildiyse ilk çıktı karesi kullanılır.</p>
      <button className="btn btn-sm" onClick={saveCover} disabled={saving || disabled}>{saving ? "Kaydediliyor…" : "Bu kareyi proje kapağı yap"}</button>
      {project.thumbnail_url && <a className="btn btn-sm" href={downloadUrl(project.thumbnail_url)} download>Mevcut proje kapağını indir</a>}
    </section>
    {running && <div role="status" aria-live="polite"><JobProgress job={running} /></div>}
    <button id="export-batch" className="btn btn-primary btn-lg" onClick={() => start()} disabled={disabled || formats.length === 0}>
      {disabled && project.status === "ready" ? "Render sürüyor…" : `${formats.length} formatı tek tıkla hazırla`}
    </button>
    {formats.length === 0 && <p className={pub.note}>En az bir platform seçin.</p>}
    <button id="export-render" className="btn" onClick={() => start(true)} disabled={disabled}>Yalnızca mevcut edit planını render et</button>
    <PublishingResults job={batch} />
    {jobs.render?.status === "failed" && <p className={pub.error} role="alert">{jobs.render.error}</p>}
    {project.output_url && <a className="btn" href={downloadUrl(project.output_url)} download id="export-download">Son tekli render · MP4 indir</a>}
    {project.has_transcript && <div className={pub.actions}>
      <a className="btn btn-sm" href={api.subtitleExportUrl(project.id, "srt")}>SRT altyazı</a>
      <a className="btn btn-sm" href={api.subtitleExportUrl(project.id, "vtt")}>VTT altyazı</a>
    </div>}
  </div>;
}
