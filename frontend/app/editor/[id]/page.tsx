"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl, waitForJob, type Job, type JobMap, type Library, type Project, type Storyboard, type TimelineInfo } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import Player from "@/components/editor/Player";
import Timeline from "@/components/editor/Timeline";
import EditPanel from "@/components/editor/EditPanel";
import SubtitlePanel from "@/components/editor/SubtitlePanel";
import AudioPanel from "@/components/editor/AudioPanel";
import ExportPanel from "@/components/editor/ExportPanel";
import TemplatesPanel from "@/components/editor/TemplatesPanel";
import VoiceoverPanel from "@/components/editor/VoiceoverPanel";
import BrollPanel from "@/components/editor/BrollPanel";
import ClipperPanel from "@/components/editor/ClipperPanel";
import StoryboardPanel from "@/components/editor/StoryboardPanel";
import SceneTimeline from "@/components/editor/SceneTimeline";
import TranscriptPanel from "@/components/editor/TranscriptPanel";
import styles from "./editor.module.css";
import { mainRenderFreshness, mainRenderMessage } from "@/lib/render-preview";

type PanelTab = "scenes" | "templates" | "voiceover" | "broll" | "edit" | "transcript" | "subtitles" | "audio" | "clips" | "export";
const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: "scenes", label: "Sahneler", icon: "▤" },
  { id: "templates", label: "Şablonlar", icon: "⚡" },
  { id: "voiceover", label: "Seslendirme", icon: "🎙️" },
  { id: "broll", label: "B-Roll", icon: "🖼️" },
  { id: "edit", label: "AI Edit", icon: "✨" },
  { id: "transcript", label: "Metinden Edit", icon: "☷" },
  { id: "subtitles", label: "Altyazı", icon: "💬" },
  { id: "audio", label: "Ses", icon: "🎵" },
  { id: "clips", label: "Kısa Klipler", icon: "✂" },
  { id: "export", label: "Dışa Aktar", icon: "⬇" },
];

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const [project, updateProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [storyDraft, setStoryDraft] = useState<Storyboard | null>(null);
  const [storyPending, setStoryPending] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [timeline, setTimeline] = useState<TimelineInfo | null>(null);
  const [tab, setTab] = useState<PanelTab>("templates");
  const [view, setView] = useState<"source" | "output">("source");
  const [jobs, setJobs] = useState<JobMap>({});
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [time, setTime] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tracking = useRef<Map<string, AbortController>>(new Map());
  const setProject = useCallback((p: Project) => {
    updateProject(p);
    setStoryDraft((current) => current?.revision === p.storyboard?.revision ? current : p.storyboard ?? null);
  }, []);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 4200);
  }, []);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const p = await api.project(id);
    if (!signal?.aborted) setProject(p);
    return p;
  }, [id, setProject]);

  const track = useCallback(
    async (job: Job, onDone?: (job: Job) => void) => {
      if (tracking.current.has(job.id)) return;
      const controller = new AbortController();
      tracking.current.set(job.id, controller);
      setJobs((m) => ({ ...m, [job.kind]: job }));
      try {
        const final = await waitForJob(job.id, (j) => setJobs((m) => ({ ...m, [j.kind]: j })), 1000, {
          signal: controller.signal,
          onConnectionChange: (connected) => notify(connected ? "Bağlantı geri geldi; iş takibi sürüyor." :
            "Bağlantı kesildi; iş yeniden başlatılmadan takip tekrar denenecek.", !connected),
        });
        try { await reload(controller.signal); }
        catch { if (!controller.signal.aborted) notify("İş sonucu alındı, proje yenilenemedi; sayfayı yenileyebilirsiniz.", true); }
        if (controller.signal.aborted) return;
        if (final.status === "failed") notify(final.error || "İşlem başarısız.", true);
        else onDone?.(final);
      } catch (e) {
        if (controller.signal.aborted) return;
        notify((e as Error).message, true);
        setJobs((m) => {
          if (m[job.kind]?.id !== job.id) return m;
          const next = { ...m }; delete next[job.kind]; return next;
        });
      } finally {
        if (tracking.current.get(job.id) === controller) tracking.current.delete(job.id);
      }
    },
    [reload, notify],
  );

  useEffect(() => {
    const active = tracking.current;
    return () => {
      active.forEach((controller) => controller.abort());
      active.clear();
    };
  }, [id]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    api.project(id, signal).then((p) => {
      if (!disposed) { setLoadError(null); setProject(p); if (p.storyboard) setTab("scenes"); }
    }).catch((e: Error) => {
      if (!disposed) setLoadError({ id, message: e.name === "TimeoutError" ? "Proje isteği zaman aşımına uğradı." : e.message });
    });
    api.library().then((value) => { if (!disposed) setLibrary(value); }).catch(() => {});
    api
      .jobs(id)
      .then((list) => {
        if (disposed) return;
        const latest: JobMap = {};
        list.forEach((j) => { if (!latest[j.kind]) latest[j.kind] = j; });
        setJobs((current) => ({ ...latest, ...Object.fromEntries(
          Object.entries(current).filter(([, job]) => job?.project_id === id),
        ) }));
        list.filter((j) => j.status === "queued" || j.status === "running").forEach((j) => track(j));
      })
      .catch(() => {});
    return () => { disposed = true; controller.abort(); };
  }, [id, track, notify, setProject, loadAttempt]);

  // Üretim sürüyorsa periyodik yenile
  useEffect(() => {
    if (project?.status !== "generating") return;
    const controller = new AbortController();
    let pending = false;
    const t = setInterval(() => {
      if (pending) return;
      pending = true;
      void reload(controller.signal).catch(() => {}).finally(() => { pending = false; });
    }, 2500);
    return () => { controller.abort(); clearInterval(t); };
  }, [project?.status, reload]);

  // Plan değişince zaman çizelgesini güncelle
  const planKey = JSON.stringify(project?.plan ?? null);
  useEffect(() => {
    if (project?.status !== "ready") return;
    let cancelled = false;
    const t = setTimeout(() => api.timeline(id).then((value) => { if (!cancelled) setTimeline(value); }).catch(() => {}), 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [planKey, project?.status, project?.source_url, project?.duration, id]);

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

  if (!project || project.id !== id) {
    const message = loadError?.id === id ? loadError.message : null;
    if (message) return (
      <main className={`${styles.page} ${styles.loadError}`}>
        <div role="alert">
          <h1>Proje yüklenemedi</h1>
          <p>{message}</p>
          <p>Bağlantıyı kontrol edip yeniden deneyin. Proje silinmişse proje listesine dönün.</p>
        </div>
        <button id="editor-retry" className="btn btn-primary" onClick={() => { setLoadError(null); setLoadAttempt((value) => value + 1); }}>
          Yeniden dene
        </button>
        <Link href="/dashboard" className="btn btn-ghost">Projelere dön</Link>
      </main>
    );
    return (
      <main className={styles.loading} role="status" aria-live="polite">
        <span className="spinner" /> Proje yükleniyor…
      </main>
    );
  }

  const isGenerating = project.status === "generating";
  const genJob = project.storyboard ? jobs.storyboard_generate : jobs.generate;

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
        {project.origin === "storyboard" && <span className="chip">▤ Çok sahneli</span>}
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
          {isGenerating || project.status === "failed" || !project.source_url ? (
            <div className={`${styles.generating} glass`}>
              {isGenerating ? (
                <>
                  <div className={styles.genOrb} />
                  <h2>{project.storyboard ? "Sahneler üretiliyor" : "Video üretiliyor"}</h2>
                  <p>{genJob?.message || "Veo sahneyi oluşturuyor…"}</p>
                  <div className="progress" style={{ width: 320 }}>
                    <span style={{ width: `${Math.max(5, (genJob?.progress ?? 0.05) * 100)}%` }} />
                  </div>
                  {project.generation_prompt && <blockquote>“{project.generation_prompt}”</blockquote>}
                </>
              ) : project.storyboard ? (
                <>
                  <h2>{project.status === "failed" ? "Sahne üretimi tamamlanamadı" : "Sahne planınız hazır"}</h2>
                  <p>Sahneler panelinden planı inceleyin, düzenleyin ve üretimi onaylayın. Yükleme yapmanız gerekmez.</p>
                  <button className="btn btn-primary" onClick={() => setTab("scenes")}>Sahne planını aç</button>
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
                  Render Çıktısı {mainRenderFreshness(project) === "fresh" ? "✓" : ""}
                </button>
              </div>
              {view === "output" && project.output_url && <p role="status" aria-live="polite">{mainRenderMessage(project)}</p>}
              <Player
                ref={videoRef}
                project={project}
                view={view}
                src={view === "output" ? mediaUrl(project.output_url) : mediaUrl(project.source_url)}
                onTime={setTime}
              />
              {timeline && <div hidden={view !== "source"}>
                <Timeline project={project} timeline={timeline} time={time} onSeek={seek} setProject={setProject} onTimeline={setTimeline} notify={notify} />
              </div>}
            </>
          )}
          {project.storyboard && storyDraft && <SceneTimeline draft={storyDraft} runtime={project.storyboard} onChange={setStoryDraft}
            disabled={storyPending || project.status === "generating" || jobs.storyboard_generate?.status === "queued" || jobs.storyboard_generate?.status === "running"}
            onPreview={() => videoRef.current?.pause()} />}
        </section>

        <aside className={`${styles.panel} glass`}>
          <nav className={styles.panelTabs}>
            {TABS.filter((t) => t.id !== "scenes" || project.storyboard).map((t) => (
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
            {tab === "scenes" && project.storyboard && storyDraft && <StoryboardPanel key={project.storyboard.revision} project={project} setProject={setProject} draft={storyDraft} setDraft={setStoryDraft} pending={storyPending} setPending={setStoryPending} jobs={jobs} track={track} notify={notify} />}
            {tab === "templates" && (
              <TemplatesPanel project={project} setProject={setProject} notify={notify} disabled={project.status !== "ready"} />
            )}
            {tab === "voiceover" && (
              <VoiceoverPanel project={project} setProject={setProject} notify={notify} disabled={project.status !== "ready"} />
            )}
            {tab === "broll" && (
              <BrollPanel
                project={project}
                setProject={setProject}
                notify={notify}
                disabled={project.status !== "ready"}
                time={time}
                seek={seek}
              />
            )}
            {tab === "edit" && <EditPanel project={project} setProject={setProject} notify={notify} disabled={project.status !== "ready"} />}
            {tab === "transcript" && <TranscriptPanel project={project} setProject={setProject} jobs={jobs} track={track} notify={notify} seek={seek} />}
            {tab === "subtitles" && (
              <SubtitlePanel project={project} setProject={setProject} library={library} jobs={jobs} track={track} notify={notify} seek={seek} time={time} />
            )}
            {tab === "audio" && <AudioPanel project={project} setProject={setProject} library={library} notify={notify} />}
            {tab === "clips" && <ClipperPanel project={project} jobs={jobs} track={track} notify={notify} />}
            {tab === "export" && (
              <ExportPanel
                project={project}
                setProject={setProject}
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
