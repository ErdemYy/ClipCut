"use client";

import { useEffect, useState } from "react";
import { api, downloadUrl, formatTime, mediaUrl, type Job, type JobMap, type PreviewResult, type Project, type RenderOptions } from "@/lib/api";
import { previewIsStale, previewRange } from "@/lib/render-preview";
import { JobProgress } from "./SubtitlePanel";
import pub from "./publishing.module.css";

type Props = {
  project: Project; options: RenderOptions; jobs: JobMap;
  track: (job: Job, onDone?: (job: Job) => void) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
};

export default function PreviewPanel({ project, options, jobs, track, notify }: Props) {
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState<5 | 10>(5);
  const [pending, setPending] = useState(false);
  const [timeline, setTimeline] = useState<{ key: string; total: number; error?: string } | null>(null);
  const timelineKey = JSON.stringify([project.id, project.source_url, project.duration, project.plan]);
  const projectId = project.id;
  useEffect(() => {
    let cancelled = false;
    api.timeline(projectId).then((value) => {
      if (!cancelled) setTimeline({ key: timelineKey, total: value.output_duration });
    }).catch((error: Error) => {
      if (!cancelled) setTimeline({ key: timelineKey, total: 0, error: error.message });
    });
    return () => { cancelled = true; };
  }, [projectId, timelineKey]);

  const loaded = timeline?.key === timelineKey;
  const total = loaded ? timeline.total : 0;
  const range = previewRange(start, duration, total);
  const job = jobs.preview;
  const running = job?.status === "running" || job?.status === "queued";
  const disabled = pending || running || project.status !== "ready" || !loaded || total < 0.1;
  const result = job?.status === "done" && job.result ? job.result as PreviewResult : null;
  const stale = result && previewIsStale(result, project.render_revision, options);

  const generate = async () => {
    setPending(true);
    try {
      const next = await api.preview(project.id, { ...options, start: range.start, duration });
      await track(next, () => notify("Kısa önizleme hazır. Tam render çıktınız değiştirilmedi."));
    } catch (error) { notify((error as Error).message, true); }
    finally { setPending(false); }
  };

  return <section className={pub.cover} aria-labelledby="render-preview-title">
    <h4 id="render-preview-title">Kısa render önizlemesi</h4>
    <p id="render-preview-help" className={pub.note}>Başlangıç, kesme ve hız uygulanmış videonun zamanıdır; kaynak oynatıcının zamanı değildir. Mevcut edit planının kadrajı ve yukarıdaki çözünürlük/kalite kullanılır; platform seçimleri uygulanmaz.</p>
    <fieldset className={pub.settings} disabled={disabled} aria-describedby="render-preview-help">
      <legend>Önizleme aralığı</legend>
      <label htmlFor="render-preview-start">Başlangıç (saniye)
        <input id="render-preview-start" className="input" type="number" min="0" max={range.maxStart} step="0.001" value={range.start}
          onChange={(e) => setStart(Number(e.target.value))} />
      </label>
      <label htmlFor="render-preview-duration">Süre
        <select id="render-preview-duration" className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value) as 5 | 10)}>
          <option value={5}>5 saniye</option><option value={10}>10 saniye</option>
        </select>
      </label>
    </fieldset>
    {!loaded ? <p className={pub.note} role="status">Düzenlenmiş süre hesaplanıyor…</p> : timeline.error ?
      <p className={pub.error} role="alert">{timeline.error}</p> :
      <p className={pub.note}>Seçim: {range.start.toFixed(2)}–{range.end.toFixed(2)} sn · toplam {formatTime(total)}. Video sonunda kalan süre kullanılır.</p>}
    <p className={pub.note}>Ücretli AI çağrısı yapılmaz. Geç bir aralıkta önceki karelerin işlenmesi gerekebilir; hazırlık sırasında ilerleme bekleyebilir.</p>
    <button id="render-preview-generate" className="btn" disabled={disabled} onClick={generate}>{pending || running ? "Önizleme hazırlanıyor…" : "Kısa önizleme oluştur"}</button>
    {running && <div role="status" aria-live="polite"><JobProgress job={job} /></div>}
    {job?.status === "failed" && <p className={pub.error} role="alert">{job.error || "Önizleme oluşturulamadı; yeniden deneyin."}</p>}
    {result && <div className={pub.output}>
      <strong>{stale ? "Önceki ayarlardan önizleme" : "İşlenmiş önizleme"} · {result.start.toFixed(2)}–{result.end.toFixed(2)} sn</strong>
      {stale && <p className={pub.note} role="status">Edit veya render ayarları değişti. Güncel sonucu görmek için yeniden önizleme oluşturun.</p>}
      <video key={result.output} src={mediaUrl(result.output)} controls playsInline preload="metadata" aria-label="FFmpeg ile işlenmiş kısa render önizlemesi" />
      <p className={pub.note}>{result.width} × {result.height} · {result.duration.toFixed(2)} sn · {result.resolution} / {result.quality}. Tam render dosyası korunur.</p>
      <a className="btn btn-sm" href={downloadUrl(result.output)} download>Bu önizlemeyi indir</a>
    </div>}
  </section>;
}
