"use client";

import { useEffect, useState } from "react";
import { api, formatTime, type Job, type Library, type Operation, type Project } from "@/lib/api";
import type { JobMap } from "@/lib/api";
import styles from "./editor-parts.module.css";

const STYLE_INFO: Record<string, { label: string; hint: string }> = {
  karaoke: { label: "Karaoke", hint: "KonuÅŸuldukÃ§a renklenir" },
  word_pop: { label: "Pop", hint: "Aktif kelime bÃ¼yÃ¼r" },
  classic: { label: "Klasik", hint: "Sinema altyazÄ±sÄ±" },
  boxed: { label: "Kutulu", hint: "Arka planlÄ±" },
  minimal: { label: "Minimal", hint: "Sade ve ince" },
};

const DEFAULT_SUB: Operation = {
  type: "subtitles", enabled: true, style: "karaoke", font: "Montserrat", size: "medium",
  primary_color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", position: "bottom", uppercase: false, max_words_per_line: 0,
};

type Props = {
  project: Project;
  setProject: (p: Project) => void;
  library: Library | null;
  jobs: JobMap;
  track: (job: Job, onDone?: (job: Job) => void) => Promise<void>;
  notify: (t: string, e?: boolean) => void;
  seek: (t: number) => void;
  time: number;
};

export default function SubtitlePanel({ project, setProject, library, jobs, track, notify, seek, time }: Props) {
  const [target, setTarget] = useState(project.subtitle_language || "tr");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const languages = library?.languages ?? [{ code: "tr", name: "TÃ¼rkÃ§e" }, { code: "en", name: "English" }];
  const sub = (project.plan?.operations.find((o) => o.type === "subtitles") ?? null) as Operation | null;
  const running = (k: "transcribe" | "translate") => jobs[k] && (jobs[k]!.status === "queued" || jobs[k]!.status === "running");
  const activeJob = running("transcribe") ? jobs.transcribe : running("translate") ? jobs.translate : null;

  useEffect(() => setDrafts({}), [project.subtitles]);

  const transcribe = async () => {
    try {
      const job = await api.transcribe(project.id, target);
      track(job, () => notify("AltyazÄ±lar hazÄ±r"));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const translate = async () => {
    try {
      const job = await api.translate(project.id, target);
      track(job, () => notify(`AltyazÄ± Ã§evrildi â†’ ${target.toUpperCase()}`));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const updateSub = async (patch: Record<string, unknown>) => {
    const ops = project.plan?.operations ?? [];
    const base = sub ?? DEFAULT_SUB;
    const next = { ...base, ...patch };
    const plan = { operations: sub ? ops.map((o) => (o.type === "subtitles" ? next : o)) : [...ops, next] };
    setProject({ ...project, plan });
    try {
      setProject(await api.setPlan(project.id, plan));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const saveTexts = async () => {
    const segs = project.subtitles?.segments ?? [];
    try {
      const p = await api.saveSubtitles(
        project.id,
        segs.map((s) => ({ id: s.id, start: s.start, end: s.end, text: drafts[s.id] ?? s.text })),
      );
      setProject(p);
      notify("AltyazÄ± metinleri kaydedildi");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  if (!project.has_transcript) {
    return (
      <div className={styles.section}>
        <div className={styles.hero}>
          <span>ğŸ’¬</span>
          <h3>Profesyonel altyazÄ±</h3>
          <p>Gemini konuÅŸmayÄ± kelime kelime yazÄ±ya dÃ¶ker ve seÃ§tiÄŸin dile Ã§evirir.</p>
        </div>
        <label className="label" htmlFor="sub-target">AltyazÄ± dili</label>
        <select id="sub-target" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
        {activeJob ? (
          <JobProgress job={activeJob} />
        ) : (
          <button id="sub-generate" className="btn btn-primary" onClick={transcribe} disabled={project.status !== "ready"}>
            âœ¦ AltyazÄ± OluÅŸtur
          </button>
        )}
        {!project.has_audio && <p className={styles.muted}>Bu videoda ses kanalÄ± bulunamadÄ±.</p>}
      </div>
    );
  }

  const segs = project.subtitles?.segments ?? [];
  const dirty = Object.keys(drafts).length > 0;

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="sub-lang">
            Dil Â· kaynak {project.transcript_language?.toUpperCase()}
          </label>
          <select id="sub-lang" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>
        </div>
        <button
          id="sub-translate"
          className="btn"
          onClick={translate}
          disabled={!!activeJob || target === project.subtitle_language}
          style={{ alignSelf: "flex-end" }}
        >
          Ã‡evir
        </button>
      </div>
      {activeJob && <JobProgress job={activeJob} />}

      <span className="label">Stil</span>
      <div className={styles.styleCards}>
        {Object.entries(STYLE_INFO).map(([key, info]) => (
          <button
            key={key}
            id={`sub-style-${key}`}
            className={`${styles.styleCard} ${sub?.style === key ? styles.styleCardOn : ""}`}
            onClick={() => updateSub({ style: key, enabled: true })}
          >
            <strong className={styles[`sample_${key}`]}>Aa</strong>
            <span>{info.label}</span>
            <small>{info.hint}</small>
          </button>
        ))}
      </div>

      <div className={styles.grid2}>
        <div>
          <label className="label" htmlFor="sub-font">Font</label>
          <select id="sub-font" className="select" value={String(sub?.font ?? "Montserrat")} onChange={(e) => updateSub({ font: e.target.value })}>
            {(library?.fonts ?? ["Montserrat"]).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sub-size">Boyut</label>
          <select id="sub-size" className="select" value={String(sub?.size ?? "medium")} onChange={(e) => updateSub({ size: e.target.value })}>
            <option value="small">KÃ¼Ã§Ã¼k</option>
            <option value="medium">Orta</option>
            <option value="large">BÃ¼yÃ¼k</option>
          </select>
        </div>
        <div>
          <span className="label">Konum</span>
          <div className={styles.segmented}>
            {[["top", "Ãœst"], ["middle", "Orta"], ["bottom", "Alt"]].map(([v, l]) => (
              <button key={v} id={`sub-pos-${v}`} className={sub?.position === v ? styles.segOn : ""} onClick={() => updateSub({ position: v })}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="label">Renkler</span>
          <div className={styles.colors}>
            <label title="Metin rengi">
              <input type="color" value={String(sub?.primary_color ?? "#FFFFFF")} onChange={(e) => updateSub({ primary_color: e.target.value.toUpperCase() })} />
            </label>
            <label title="Vurgu rengi">
              <input type="color" value={String(sub?.highlight_color ?? "#FFD400")} onChange={(e) => updateSub({ highlight_color: e.target.value.toUpperCase() })} />
            </label>
            <label title="Kontur rengi">
              <input type="color" value={String(sub?.outline_color ?? "#000000")} onChange={(e) => updateSub({ outline_color: e.target.value.toUpperCase() })} />
            </label>
            <button
              id="sub-uppercase"
              className={`${styles.toggle} ${sub?.uppercase ? styles.toggleOn : ""}`}
              onClick={() => updateSub({ uppercase: !sub?.uppercase })}
              title="BÃ¼yÃ¼k harf"
            >
              AA
            </button>
          </div>
        </div>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={sub ? sub.enabled !== false : false} onChange={(e) => updateSub({ enabled: e.target.checked })} id="sub-enabled" />
        AltyazÄ±yÄ± videoya yak
      </label>

      <div className={styles.planHead}>
        <h4>Metinler Â· {segs.length}</h4>
        <div className={styles.row}>
          <a className="btn btn-sm" href={api.subtitleExportUrl(project.id, "srt")} id="sub-export-srt">SRT</a>
          <a className="btn btn-sm" href={api.subtitleExportUrl(project.id, "vtt")} id="sub-export-vtt">VTT</a>
          <button className="btn btn-sm btn-primary" onClick={saveTexts} disabled={!dirty} id="sub-save">Kaydet</button>
        </div>
      </div>
      <ul className={styles.segments}>
        {segs.map((s) => {
          const active = time >= s.start && time <= s.end;
          return (
            <li key={s.id} className={`${styles.segment} ${active ? styles.segmentActive : ""}`}>
              <button className={styles.segTime} onClick={() => seek(s.start)} title="Bu noktaya git">
                {formatTime(s.start)}
              </button>
              <textarea
                rows={1}
                value={drafts[s.id] ?? s.text}
                onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                id={`sub-text-${s.id}`}
              />
            </li>
          );
        })}
      </ul>
      {segs.length === 0 && <p className={styles.muted}>KonuÅŸma bulunamadÄ±.</p>}
    </div>
  );
}

export function JobProgress({ job }: { job: Job }) {
  return (
    <div className={styles.jobBox}>
      <div className={styles.jobHead}>
        <span>{job.message || "Ã‡alÄ±ÅŸÄ±yor"}</span>
        <span>{Math.round(job.progress * 100)}%</span>
      </div>
      <div className="progress">
        <span style={{ width: `${Math.max(4, job.progress * 100)}%` }} />
      </div>
    </div>
  );
}
