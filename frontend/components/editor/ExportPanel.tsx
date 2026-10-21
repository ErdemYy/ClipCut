"use client";

import { api, formatTime, mediaUrl, type Job, type Project } from "@/lib/api";
import type { JobMap } from "@/lib/api";
import { JobProgress } from "./SubtitlePanel";
import styles from "./editor-parts.module.css";

type Props = {
  project: Project;
  jobs: JobMap;
  track: (job: Job, onDone?: (job: Job) => void) => Promise<void>;
  notify: (t: string, e?: boolean) => void;
  onRendered: () => void;
};

export default function ExportPanel({ project, jobs, track, notify, onRendered }: Props) {
  const job = jobs.render;
  const running = job && (job.status === "queued" || job.status === "running");
  const meta = project.output_meta;
  const reframe = project.plan?.operations.find((o) => o.type === "reframe");

  const start = async () => {
    try {
      const j = await api.render(project.id);
      track(j, () => {
        notify("Render tamamlandÄ± ğŸ‰");
        onRendered();
      });
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.hero}>
        <span>ğŸ¬</span>
        <h3>DÄ±ÅŸa aktar</h3>
        <p>Edit planÄ± FFmpeg ile 1080p H.264 MP4 olarak render edilir.</p>
      </div>

      <div className={styles.summary}>
        <div><small>Format</small><strong>{reframe ? String(reframe.aspect_ratio) : "Orijinal"}</strong></div>
        <div><small>Ä°ÅŸlem</small><strong>{project.plan?.operations.length ?? 0}</strong></div>
        <div><small>AltyazÄ±</small><strong>{project.subtitle_language?.toUpperCase() ?? "â€”"}</strong></div>
      </div>

      {running ? (
        <JobProgress job={job} />
      ) : (
        <button id="export-render" className="btn btn-primary btn-lg" onClick={start} disabled={project.status !== "ready"}>
          âš¡ Render Al
        </button>
      )}

      {project.output_url && meta && (
        <div className={`${styles.result} fade-in`}>
          <div className={styles.resultHead}>
            <strong>Son render</strong>
            <small>{new Date(meta.rendered_at).toLocaleString("tr-TR")}</small>
          </div>
          <div className={styles.summary}>
            <div><small>Ã‡Ã¶zÃ¼nÃ¼rlÃ¼k</small><strong>{meta.width}Ã—{meta.height}</strong></div>
            <div><small>SÃ¼re</small><strong>{formatTime(meta.duration)}</strong></div>
          </div>
          <a className="btn btn-primary" href={mediaUrl(project.output_url)} download id="export-download">
            â¬‡ MP4 Ä°ndir
          </a>
          {project.has_transcript && (
            <div className={styles.row}>
              <a className="btn btn-sm" style={{ flex: 1 }} href={api.subtitleExportUrl(project.id, "srt")} id="export-srt">SRT altyazÄ±</a>
              <a className="btn btn-sm" style={{ flex: 1 }} href={api.subtitleExportUrl(project.id, "vtt")} id="export-vtt">VTT altyazÄ±</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
