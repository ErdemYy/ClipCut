"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl, waitForJob, type Job, type JobMap, type Library, type Project, type Storyboard } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import Player from "@/components/editor/Player";
import TimelineWorkspace from "@/components/editor/TimelineWorkspace";
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

type AuxiliaryKind = "library" | "jobs";
type ReadStatus = { id: string; pending: boolean; error: string | null; loaded: boolean };
const AUXILIARY_READS: { kind: AuxiliaryKind; label: string; retry: string; refresh: string }[] = [
  { kind: "library", label: "Kütüphane", retry: "Kütüphaneyi yeniden dene", refresh: "Kütüphaneyi yenile" },
  { kind: "jobs", label: "İş listesi", retry: "İş listesini yeniden dene", refresh: "İş listesini yenile" },
];

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const [project, updateProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [storyDraft, setStoryDraft] = useState<Storyboard | null>(null);
  const [storyPending, setStoryPending] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [tab, setTab] = useState<PanelTab>("templates");
  const [view, setView] = useState<"source" | "output">("source");
  const [jobState, setJobs] = useState<JobMap>({});
  const jobs: JobMap = Object.fromEntries(Object.entries(jobState).filter(([, job]) => job?.project_id === id));
  const [readStatus, setReadStatus] = useState<Record<AuxiliaryKind, ReadStatus>>({
    library: { id, pending: true, error: null, loaded: false },
    jobs: { id, pending: true, error: null, loaded: false },
  });
  const readRequests = useRef<Record<AuxiliaryKind, AbortController | null>>({ library: null, jobs: null });
  const jobChanges = useRef<Partial<Record<Job["kind"], number>>>({});
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [time, setTime] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tracking = useRef<Map<string, AbortController>>(new Map());
  const projectSnapshot = useRef<Project | null>(null);
  const projectRoute = useRef(id);
  useEffect(() => { projectRoute.current = id; }, [id]);
  const setProject = useCallback((p: Project) => {
    if (p.id !== projectRoute.current) return;
    const current = projectSnapshot.current;
    // Preserve microseconds: Date.parse truncates them and can accept an older response.
    const stamp = (value: string) => value.replace(/(?:Z|\+00:00)$/, "").padEnd(26, "0");
    if (current?.id === p.id && stamp(p.updated_at) < stamp(current.updated_at)) return;
    projectSnapshot.current = p;
    updateProject(p);
    setStoryDraft((current) => current?.revision === p.storyboard?.revision ? current : p.storyboard ?? null);
  }, []);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 4200);
  }, []);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const p = await api.project(id, signal);
    if (!signal?.aborted) setProject(p);
    return p;
  }, [id, setProject]);

  const track = useCallback(
    async (job: Job, onDone?: (job: Job) => void) => {
      if (job.project_id !== projectRoute.current || tracking.current.has(job.id)) return;
      const controller = new AbortController();
      tracking.current.set(job.id, controller);
      jobChanges.current[job.kind] = (jobChanges.current[job.kind] ?? 0) + 1;
      setJobs((m) => ({ ...m, [job.kind]: job }));
      try {
        const final = await waitForJob(job.id, (j) => {
          if (controller.signal.aborted || j.project_id !== projectRoute.current) return;
          jobChanges.current[j.kind] = (jobChanges.current[j.kind] ?? 0) + 1;
          setJobs((m) => m[j.kind]?.id && m[j.kind]?.id !== j.id ? m : { ...m, [j.kind]: j });
        }, 1000, {
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
        jobChanges.current[job.kind] = (jobChanges.current[job.kind] ?? 0) + 1;
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

  const loadAuxiliary = useCallback(async (kind: AuxiliaryKind) => {
    if (projectRoute.current !== id || readRequests.current[kind]) return;
    const controller = new AbortController();
    readRequests.current[kind] = controller;
    const before = { ...jobChanges.current };
    setReadStatus((current) => ({ ...current, [kind]: {
      id, pending: true, error: current[kind].id === id ? current[kind].error : null,
      loaded: current[kind].id === id && current[kind].loaded,
    } }));
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      if (kind === "library") {
        const value = await api.library(signal);
        signal.throwIfAborted();
        if (projectRoute.current !== id) return;
        setLibrary(value);
      } else {
        const list = await api.jobs(id, signal);
        signal.throwIfAborted();
        if (projectRoute.current !== id) return;
        const latest: JobMap = {};
        list.filter((j) => j.project_id === id).forEach((j) => { if (!latest[j.kind]) latest[j.kind] = j; });
        // A list GET is authoritative unless this kind changed locally after that GET began.
        const changed = new Set((Object.keys(jobChanges.current) as Job["kind"][])
          .filter((kind) => jobChanges.current[kind] !== before[kind]));
        const monitored = new Set(tracking.current.keys());
        setJobs((current) => {
          const next = { ...latest };
          // /jobs is a bounded recent list, not proof that an omitted watched job disappeared.
          Object.values(current).forEach((job) => {
            if (job?.project_id === id && monitored.has(job.id) && !next[job.kind] &&
                (job.status === "queued" || job.status === "running")) next[job.kind] = job;
          });
          changed.forEach((kind) => {
            if (current[kind]?.project_id === id) next[kind] = current[kind];
            else delete next[kind];
          });
          return next;
        });
        Object.values(latest).filter((j): j is Job => !!j && !changed.has(j.kind) &&
          (j.status === "queued" || j.status === "running")).forEach((j) => { void track(j); });
      }
      setReadStatus((current) => ({ ...current, [kind]: { id, pending: false, error: null, loaded: true } }));
    } catch (error) {
      if (!controller.signal.aborted && projectRoute.current === id) {
        const message = (error as Error).name === "TimeoutError" ? "İstek zaman aşımına uğradı." : (error as Error).message;
        setReadStatus((current) => ({ ...current, [kind]: { ...current[kind], id, pending: false, error: message } }));
      }
    } finally {
      if (readRequests.current[kind] === controller) readRequests.current[kind] = null;
    }
  }, [id, track]);

  useEffect(() => {
    let disposed = false;
    const requests = readRequests.current;
    void Promise.resolve().then(() => {
      if (!disposed) AUXILIARY_READS.forEach(({ kind }) => { void loadAuxiliary(kind); });
    });
    return () => {
      disposed = true;
      AUXILIARY_READS.forEach(({ kind }) => { requests[kind]?.abort(); requests[kind] = null; });
    };
  }, [loadAuxiliary, loadAttempt]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    api.project(id, signal).then((p) => {
      if (!disposed) { setLoadError(null); setProject(p); if (p.storyboard) setTab("scenes"); }
    }).catch((e: Error) => {
      if (!disposed) setLoadError({ id, message: e.name === "TimeoutError" ? "Proje isteği zaman aşımına uğradı." : e.message });
    });
    return () => { disposed = true; controller.abort(); };
  }, [id, setProject, loadAttempt]);

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
    if (project && name.trim() && name !== project.name) {
      try { setProject(await api.rename(id, name)); }
      catch (error) { notify((error as Error).message, true); }
    }
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

      <section className={styles.reads} aria-label="Veri yükleme durumu">
        {AUXILIARY_READS.map(({ kind, label, retry, refresh }) => {
          const state = readStatus[kind].id === id ? readStatus[kind] : { pending: true, error: null, loaded: false };
          const cached = kind === "library" ? library !== null : state.loaded || Object.keys(jobs).length > 0;
          return (
            <div key={kind} className={styles.readRow}>
              <div>
                <strong>{label}</strong>
                {state.pending && <p role="status">{state.loaded ? "Yenileniyor…" : "Yükleniyor…"}</p>}
              </div>
              <button id={`editor-${kind}-retry`} className="btn btn-ghost"
                aria-label={state.error ? retry : refresh}
                aria-describedby={state.error ? `editor-${kind}-error` : undefined}
                disabled={state.pending} onClick={() => { void loadAuxiliary(kind); }}>
                {state.pending ? "Yükleniyor…" : state.error ? "Yeniden dene" : "Yenile"}
              </button>
              {state.error && <div id={`editor-${kind}-error`} className={styles.readError} role="alert">
                <p>{label} {cached ? "yenilenemedi" : "yüklenemedi"}. {state.error}</p>
                <p>{cached ? "Son bilinen veriler korunuyor." : "Bağlantıyı kontrol edip yeniden deneyin."} Yeniden deneme yalnızca verileri okur, yeni işlem başlatmaz.</p>
              </div>}
            </div>
          );
        })}
      </section>

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
              <div hidden={view !== "source"}>
                <TimelineWorkspace project={project} time={time} onSeek={seek} setProject={setProject} notify={notify} />
              </div>
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
