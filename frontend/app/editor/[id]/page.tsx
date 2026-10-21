"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl, waitForJob, type Job, type JobMap, type Library, type Project, type TimelineInfo } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import Player from "@/components/editor/Player";
import Timeline from "@/components/editor/Timeline";
import EditPanel from "@/components/editor/EditPanel";
import SubtitlePanel from "@/components/editor/SubtitlePanel";
import AudioPanel from "@/components/editor/AudioPanel";
import ExportPanel from "@/components/editor/ExportPanel";
import TemplatesPanel from "@/components/editor/TemplatesPanel";
import VoiceoverPanel from "@/components/editor/VoiceoverPanel";
import styles from "./editor.module.css";

type PanelTab = "templates" | "voiceover" | "edit" | "subtitles" | "audio" | "export";
const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: "templates", label: "Şablonlar", icon: "⚡" },
  { id: "voiceover", label: "Seslendirme", icon: "🎙️" },
  { id: "edit", label: "AI Edit", icon: "✨" },
  { id: "subtitles", label: "Altyazı", icon: "💬" },
  { id: "audio", label: "Ses", icon: "🎵" },
  { id: "export", label: "Dışa Aktar", icon: "⬇" },
];

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [timeline, setTimeline] = useState<TimelineInfo | null>(null);
  const [tab, setTab] = useState<PanelTab>("templates");
  const [view, setView] = useState<"source" | "output">("source");
  const [jobs, setJobs] = useState<JobMap>({});
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [time, setTime] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tracking = useRef<Set<string>>(new Set());

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 4200);
  }, []);

  const reload = useCallback(async () => {
    const p = await api.project(id);
    setProject(p);
    return p;
  }, [id]);

  const track = useCallback(
    async (job: Job, onDone?: (job: Job) => void) => {
      if (tracking.current.has(job.id)) return;
      tracking.current.add(job.id);
      const final = await waitForJob(job.id, (j) => setJobs((m) => ({ ...m, [j.kind]: j })));
      tracking.current.delete(job.id);
      await reload();
      if (final.status === "failed") notify(final.error || "İşlem başarısız.", true);
      else onDone?.(final);
    },
    [reload, notify],
  );

  useEffect(() => {
    reload().catch((e: Error) => notify(e.message, true));
    api.library().then(setLibrary).catch(() => {});
    api
      .jobs(id)
      .then((list) => list.filter((j) => j.status === "queued" || j.status === "running").forEach((j) => track(j)))
      .catch(() => {});
  }, [id, reload, track, notify]);

  // Üretim sürüyorsa periyodik yenile
  useEffect(() => {
    if (project?.status !== "generating") return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [project?.status, reload]);

  // Plan değişince zaman çizelgesini güncelle
  const planKey = JSON.stringify(project?.plan ?? null);
  useEffect(() => {
    if (project?.status !== "ready") return;
    const t = setTimeout(() => api.timeline(id).then(setTimeline).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [planKey, project?.status, id]);

  const seek = (t: number) => {
    setView("source");
    requestAnimationFrame(() => {
      if (videoRef.current) {
        videoRef.current.currentTime = t;
        videoRef.current.play().catch(() => {});
      }
    });
  };

  const rename = async (name: string) => {
    setEditingName(false);
    if (project && name.trim() && name !== project.name) setProject(await api.rename(id, name));
  };

  if (!project) {
    return (
      <main className={styles.loading}>
        <span className="spinner" /> Proje yükleniyor…
      </main>
    );
  }

  const isGenerating = project.status === "generating";
  const genJob = jobs.generate;

  return (
    <main className={styles.page}>
      <div className={styles.topbar}>
        <Link href="/dashboard" className="btn btn-ghost btn-sm" id="editor-back">
          ← Projeler
        </Link>
        {editingName ? (
          <input
            autoFocus
            id="project-name-input"
            className={`input ${styles.nameInput}`}
            defaultValue={project.name}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && rename((e.target as HTMLInputElement).value)}
          />
        ) : (
          <h1 className={styles.name} onClick={() => setEditingName(true)} title="Yeniden adlandırmak için tıkla" id="project-name">
            {project.name}
          </h1>
        )}
        <StatusBadge status={project.status} />
        {project.origin === "veo" && <span className="chip">✦ Veo</span>}
        <div className={styles.topActions}>
          <button
            id="topbar-render"
            className="btn btn-primary btn-sm"
            disabled={project.status !== "ready" || jobs.render?.status === "running" || jobs.render?.status === "queued"}
            onClick={() => setTab("export")}
          >
            ⬇ Dışa Aktar
          </button>
        </div>
      </div>

      <div className={styles.workspace}>
        <section className={styles.stage}>
          {isGenerating || project.status === "failed" ? (
            <div className={`${styles.generating} glass`}>
              {isGenerating ? (
                <>
                  <div className={styles.genOrb} />
                  <h2>Video üretiliyor</h2>
                  <p>{genJob?.message || "Veo sahneyi oluşturuyor…"}</p>
                  <div className="progress" style={{ width: 320 }}>
                    <span style={{ width: `${Math.max(5, (genJob?.progress ?? 0.05) * 100)}%` }} />
                  </div>
                  {project.generation_prompt && <blockquote>“{project.generation_prompt}”</blockquote>}
                </>
              ) : (
                <>
                  <h2>Üretim başarısız</h2>
                  <p>Farklı bir prompt ile yeniden deneyin.</p>
                  <Link className="btn btn-primary" href="/create">
                    Yeni Video
                  </Link>
                </>
              )}
            </div>
          ) : (
            <>
              <div className={styles.viewTabs}>
                <button
                  id="view-source"
                  className={`${styles.viewTab} ${view === "source" ? styles.viewOn : ""}`}
                  onClick={() => setView("source")}
                >
                  Önizleme
                </button>
                <button
                  id="view-output"
                  className={`${styles.viewTab} ${view === "output" ? styles.viewOn : ""}`}
                  onClick={() => setView("output")}
                  disabled={!project.output_url}
                  title={project.output_url ? "" : "Henüz render alınmadı"}
                >
                  Render Çıktısı {project.output_url ? "✓" : ""}
                </button>
              </div>
              <Player
                ref={videoRef}
                project={project}
                view={view}
                src={view === "output" ? mediaUrl(project.output_url) : mediaUrl(project.source_url)}
                onTime={setTime}
              />
              {timeline && view === "source" && (
                <Timeline project={project} timeline={timeline} time={time} onSeek={seek} />
              )}
            </>
          )}
        </section>

        <aside className={`${styles.panel} glass`}>
          <nav className={styles.panelTabs}>
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`panel-${t.id}`}
                className={`${styles.panelTab} ${tab === t.id ? styles.panelTabOn : ""}`}
                onClick={() => setTab(t.id)}
              >
                <span>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
          <div className={styles.panelBody}>
            {tab === "templates" && (
              <TemplatesPanel project={project} setProject={setProject} notify={notify} disabled={project.status !== "ready"} />
            )}
            {tab === "voiceover" && (
              <VoiceoverPanel project={project} setProject={setProject} notify={notify} disabled={project.status !== "ready"} />
            )}
            {tab === "edit" && <EditPanel project={project} setProject={setProject} notify={notify} disabled={project.status !== "ready"} />}
            {tab === "subtitles" && (
              <SubtitlePanel project={project} setProject={setProject} library={library} jobs={jobs} track={track} notify={notify} seek={seek} time={time} />
            )}
            {tab === "audio" && <AudioPanel project={project} setProject={setProject} library={library} notify={notify} />}
            {tab === "export" && (
              <ExportPanel
                project={project}
                jobs={jobs}
                track={track}
                notify={notify}
                onRendered={() => setView("output")}
              />
            )}
          </div>
        </aside>
      </div>

      {toast && <div className={`toast ${toast.error ? "toast-error" : ""}`}>{toast.error ? "⚠ " : "✓ "}{toast.text}</div>}
    </main>
  );
}
