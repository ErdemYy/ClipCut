"use client";

import { useRef, useState } from "react";
import { api, formatTime, mediaUrl, type ClipAnalysis, type ClipCandidate, type FillMode, type Job, type JobMap, type Project, type RenderOptions } from "@/lib/api";
import { JobProgress } from "./SubtitlePanel";
import { PublishingResults, RenderSettings } from "./PublishingControls";
import styles from "./editor-parts.module.css";
import pub from "./publishing.module.css";

export default function ClipperPanel({ project, jobs, track, notify }: {
  project: Project; jobs: JobMap; track: (job: Job, onDone?: (j: Job) => void) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [minimum, setMinimum] = useState(30);
  const [maximum, setMaximum] = useState(60);
  const [count, setCount] = useState(5);
  const [selected, setSelected] = useState<number[]>([]);
  const [preview, setPreview] = useState<ClipCandidate | null>(null);
  const [pending, setPending] = useState(false);
  const [options, setOptions] = useState<RenderOptions>({ resolution: "1080p", quality: "standard" });
  const [fill, setFill] = useState<FillMode>("blur");
  const video = useRef<HTMLVideoElement>(null);
  const analysis = jobs.clip_analyze;
  const result = analysis?.status === "done" ? analysis.result as unknown as ClipAnalysis : null;
  const active = [analysis, jobs.clip_render].find((j) => j?.status === "running" || j?.status === "queued");
  const disabled = pending || !!active || project.status !== "ready";
  const sourceReady = project.has_audio && project.duration >= minimum;

  const analyze = async () => {
    setPending(true); setSelected([]); setPreview(null);
    try { await track(await api.analyzeClips(project.id, { min_duration: minimum, max_duration: maximum, max_clips: count }), () => notify("Klip analizi tamamlandı.")); }
    catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };
  const render = async () => {
    if (!analysis) return;
    setPending(true);
    try { await track(await api.renderClips(project.id, { ...options, analysis_id: analysis.id, clip_ids: selected, aspect_ratio: "9:16", fill }), () => notify("Bağımsız klipler hazır.")); }
    catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };

  return <div className={styles.section}>
    <header className={pub.intro}><h3>Uzun videodan kısa klipler</h3>
      <p>Kaynak sesteki duraklama ve konuşma yoğunluğuna göre 30–60 saniyelik adaylar bulunur. Mevcut gerçek transkript varsa konuşma temposu da kullanılır. Yerel çalışır; ücretli AI çağrısı yapmaz.</p>
    </header>
    <fieldset className={pub.settings} disabled={disabled}>
      <legend>Analiz aralığı</legend>
      <label>En kısa klip (sn)<input className="input" type="number" min="30" max={maximum} value={minimum} onChange={(e) => setMinimum(Number(e.target.value))} /></label>
      <label>En uzun klip (sn)<input className="input" type="number" min={minimum} max="60" value={maximum} onChange={(e) => setMaximum(Number(e.target.value))} /></label>
      <label>En fazla klip<select className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>
        {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n} klip</option>)}
      </select></label>
    </fieldset>
    {!sourceReady && <p className={pub.note}>Analiz için kaynak videoda ses ve en az {minimum} saniye süre gerekir.</p>}
    <button id="clips-analyze" className="btn btn-primary" disabled={disabled || !sourceReady || minimum < 30 || maximum > 60 || minimum > maximum} onClick={analyze}>Klip adaylarını bul</button>
    {active && <div role="status" aria-live="polite"><JobProgress job={active} /></div>}
    {analysis?.status === "failed" && <p role="alert" className={pub.error}>{analysis.error}</p>}
    {result && <section className={styles.section} aria-label="Klip adayları">
      <p className={pub.note}>{result.notice}</p>
      {result.clips.length === 0 ? <p role="status">{result.empty_reason}</p> : <>
        <h4>{result.clips.length} bağımsız aday</h4>
        <button className="btn btn-sm" disabled={disabled} onClick={() => setSelected(result.clips.map((c) => c.id))}>Tümünü seç</button>
        {result.clips.map((clip) => <article className={pub.candidate} key={clip.id}>
          <label className={pub.candidateLabel}>
            <input type="checkbox" checked={selected.includes(clip.id)} disabled={disabled} onChange={(e) => setSelected((current) => e.target.checked ? [...current, clip.id] : current.filter((i) => i !== clip.id))} />
            {formatTime(clip.start)} – {formatTime(clip.end)} · {clip.duration.toFixed(1)} sn
          </label>
          <small>Aktivite skoru {clip.score}/100 · %{Math.round(clip.speech_ratio * 100)} konuşma{clip.words_per_minute !== null ? ` · ${clip.words_per_minute} kelime/dk` : " · tempo: ses aktivitesi tahmini"}</small>
          <small>{clip.reason}</small>
          {clip.excerpt && <p>{clip.excerpt}</p>}
          <button className="btn btn-sm" onClick={() => { setPreview(clip); if (video.current) { video.current.currentTime = clip.start; video.current.play().catch(() => {}); } }}>Bu aralığı önizle</button>
        </article>)}
        <video ref={video} className={pub.clipPreview} src={mediaUrl(project.source_url)} controls playsInline preload="metadata"
          aria-label="Seçilen klip aralığını önizle"
          onTimeUpdate={(e) => { if (preview && e.currentTarget.currentTime >= preview.end) e.currentTarget.pause(); }} />
        {preview && <p className={pub.note}>Önizleme: {formatTime(preview.start)} – {formatTime(preview.end)} (kaynak kadraj)</p>}
        <RenderSettings value={options} onChange={setOptions} fill={fill} onFill={setFill} disabled={disabled} />
        <p className={pub.note}>9:16 bağımsız MP4 dosyaları hazırlanır. Kaynak ses ve varsa altyazı/renk stili korunur; editteki hız, kesimler, seslendirme ve zamanlı katmanlar bu kliplere uygulanmaz.</p>
        <button id="clips-render" className="btn btn-primary" disabled={disabled || selected.length === 0} onClick={render}>{selected.length} klibi hazırla</button>
      </>}
    </section>}
    <PublishingResults job={jobs.clip_render} />
  </div>;
}
