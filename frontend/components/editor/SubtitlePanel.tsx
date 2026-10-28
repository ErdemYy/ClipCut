"use client";

import { useState } from "react";
import { api, type Job, type Library, type Operation, type Project } from "@/lib/api";
import type { JobMap } from "@/lib/api";
import styles from "./editor-parts.module.css";
import SubtitleTimingEditor from "./SubtitleTimingEditor";

const STYLE_INFO: Record<string, { label: string; hint: string }> = {
  hormozi: { label: "Hormozi", hint: "Viral kinetik zıplama & emojiler" },
  neon: { label: "Neon", hint: "Siber parlama ve renkli kontur" },
  karaoke: { label: "Karaoke", hint: "Konuşuldukça renklenir" },
  word_pop: { label: "Pop", hint: "Aktif kelime büyür" },
  classic: { label: "Klasik", hint: "Sinema altyazısı" },
  boxed: { label: "Kutulu", hint: "Arka planlı" },
  minimal: { label: "Minimal", hint: "Sade ve ince" },
};

const DEFAULT_SUB: Operation = {
  type: "subtitles", enabled: true, style: "hormozi", font: "Montserrat", size: "medium",
  primary_color: "#FFFFFF", highlight_color: "#FFE600", outline_color: "#000000", position: "bottom", uppercase: true, max_words_per_line: 0,
  auto_emojis: true, bounce: true,
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
  const [timingDirty, setTimingDirty] = useState(false);
  const languages = library?.languages ?? [{ code: "tr", name: "Türkçe" }, { code: "en", name: "English" }];
  const sub = (project.plan?.operations.find((o) => o.type === "subtitles") ?? null) as Operation | null;
  const running = (k: "transcribe" | "translate") => jobs[k] && (jobs[k]!.status === "queued" || jobs[k]!.status === "running");
  const activeJob = running("transcribe") ? jobs.transcribe : running("translate") ? jobs.translate : null;

  const transcribe = async () => {
    try {
      const job = await api.transcribe(project.id, target);
      track(job, () => notify("Altyazılar hazır"));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const translate = async () => {
    try {
      const job = await api.translate(project.id, target);
      track(job, () => notify(`Altyazı çevrildi → ${target.toUpperCase()}`));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const updateSub = async (patch: Record<string, unknown>) => {
    const ops = project.plan?.operations ?? [];
    const base = sub ?? DEFAULT_SUB;
    const next = { ...base, ...patch };
    const plan = { operations: sub ? ops.map((o) => (o.type === "subtitles" ? next : o)) : [...ops, next] };
    try {
      setProject(await api.setPlan(project.id, plan, project.render_revision));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const selectStyle = (key: string) => {
    const patch: Record<string, unknown> = { style: key, enabled: true };
    if (key === "hormozi") {
      patch.auto_emojis = true;
      patch.uppercase = true;
      patch.highlight_color = "#FFE600";
    } else if (key === "neon") {
      patch.highlight_color = "#00F0FF";
      patch.outline_color = "#FF007F";
    }
    updateSub(patch);
  };

  if (!project.has_transcript) {
    return (
      <div className={styles.section}>
        <div className={styles.hero}>
          <span>💬</span>
          <h3>Profesyonel altyazı</h3>
          <p>Gemini konuşmayı kelime kelime yazıya döker ve seçtiğin dile çevirir.</p>
        </div>
        <label className="label" htmlFor="sub-target">Altyazı dili</label>
        <select id="sub-target" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
        {activeJob ? (
          <JobProgress job={activeJob} />
        ) : (
          <button id="sub-generate" className="btn btn-primary" onClick={transcribe} disabled={project.status !== "ready"}>
            ✦ Altyazı Oluştur
          </button>
        )}
        {!project.has_audio && <p className={styles.muted}>Bu videoda ses kanalı bulunamadı.</p>}
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="sub-lang">
            Dil · kaynak {project.transcript_language?.toUpperCase()}
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
          disabled={!!activeJob || timingDirty || target === project.subtitle_language}
          style={{ alignSelf: "flex-end" }}
        >
          Çevir
        </button>
      </div>
      {activeJob && <JobProgress job={activeJob} />}

      <span className="label">Altyazı Stili</span>
      <div className={styles.styleCards}>
        {Object.entries(STYLE_INFO).map(([key, info]) => (
          <button
            key={key}
            id={`sub-style-${key}`}
            className={`${styles.styleCard} ${sub?.style === key ? styles.styleCardOn : ""}`}
            onClick={() => selectStyle(key)}
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
            {(library?.fonts ?? ["Montserrat", "Poppins", "Inter", "Bebas Neue"]).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sub-size">Boyut</label>
          <select id="sub-size" className="select" value={String(sub?.size ?? "medium")} onChange={(e) => updateSub({ size: e.target.value })}>
            <option value="small">Küçük</option>
            <option value="medium">Orta</option>
            <option value="large">Büyük</option>
          </select>
        </div>
        <div>
          <span className="label">Konum</span>
          <div className={styles.segmented}>
            {[["top", "Üst"], ["middle", "Orta"], ["bottom", "Alt"]].map(([v, l]) => (
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
              <input type="color" value={String(sub?.highlight_color ?? "#FFE600")} onChange={(e) => updateSub({ highlight_color: e.target.value.toUpperCase() })} />
            </label>
            <label title="Kontur rengi">
              <input type="color" value={String(sub?.outline_color ?? "#000000")} onChange={(e) => updateSub({ outline_color: e.target.value.toUpperCase() })} />
            </label>
            <button
              id="sub-uppercase"
              className={`${styles.toggle} ${sub?.uppercase || sub?.style === "hormozi" ? styles.toggleOn : ""}`}
              onClick={() => updateSub({ uppercase: !sub?.uppercase })}
              title="Büyük harf"
            >
              AA
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: "8px", margin: "10px 0" }}>
        <label className={styles.check}>
          <input
            type="checkbox"
            id="sub-auto-emojis"
            checked={Boolean(sub?.auto_emojis) || sub?.style === "hormozi"}
            onChange={(e) => updateSub({ auto_emojis: e.target.checked })}
          />
          <span>🔥 Otomatik Emojiler (Alex Hormozi & Submagic)</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            id="sub-bounce"
            checked={sub?.bounce !== false}
            onChange={(e) => updateSub({ bounce: e.target.checked })}
          />
          <span>⚡ Kinetik Kelime Zıplaması (Pop & Bounce)</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={sub ? sub.enabled !== false : false}
            onChange={(e) => updateSub({ enabled: e.target.checked })}
            id="sub-enabled"
          />
          <span>Altyazıyı videoya yak (Render Burn-in)</span>
        </label>
      </div>

      <SubtitleTimingEditor project={project} setProject={setProject} notify={notify} seek={seek} time={time}
        disabled={!!activeJob || project.status !== "ready"} onDirtyChange={setTimingDirty} />
    </div>
  );
}

export function JobProgress({ job }: { job: Job }) {
  return (
    <div className={styles.jobBox}>
      <div className={styles.jobHead}>
        <span>{job.message || "Çalışıyor"}</span>
        <span>{Math.round(job.progress * 100)}%</span>
      </div>
      <div className="progress">
        <span style={{ width: `${Math.max(4, job.progress * 100)}%` }} />
      </div>
    </div>
  );
}
