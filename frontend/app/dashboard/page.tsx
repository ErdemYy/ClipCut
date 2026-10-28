"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL, downloadUrl, formatTime, mediaUrl, type Project } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import styles from "./dashboard.module.css";

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const deletion = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const value = await api.projects(signal);
      if (!controller.signal.aborted) { setProjects(value); setError(null); }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).name === "TimeoutError" ? "Proje listesi isteği zaman aşımına uğradı." : (e as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => { if (!disposed) return load(); });
    return () => { disposed = true; request.current?.abort(); request.current = null; };
  }, [load]);

  // Üretimde olan proje varsa periyodik yenile
  useEffect(() => {
    if (!projects?.some((p) => p.status === "generating")) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [projects, load]);

  const remove = async (p: Project) => {
    if (deletion.current) return;
    if (!confirm(`“${p.name}” projesi silinsin mi?`)) return;
    deletion.current = p.id;
    setDeleting(p.id);
    setActionError(null);
    try {
      await api.remove(p.id);
      request.current?.abort();
      request.current = null;
      setProjects((current) => current?.filter((item) => item.id !== p.id) ?? null);
      await load();
    } catch (e) {
      setActionError(`Proje silinemedi: ${(e as Error).message}`);
    } finally { deletion.current = null; setDeleting(null); }
  };

  const filtered = projects?.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())) ?? [];

  return (
    <main className={`container ${styles.page}`}>
      <div className={styles.head}>
        <div>
          <h1>Projeler</h1>
          <p className={styles.sub}>Ürettiğin ve düzenlediğin tüm videolar burada.</p>
        </div>
        <div className={styles.actions}>
          <input
            id="project-search"
            className="input"
            placeholder="Proje ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Link href="/create" className="btn btn-primary" id="dashboard-new">
            + Yeni Video
          </Link>
        </div>
      </div>

      {error && (
        <div className={`${styles.empty} glass`} role="alert">
          <h3>{projects ? "Proje listesi yenilenemedi" : "Projeler yüklenemedi"}</h3>
          <p>{projects ? "Son yüklenen liste gösteriliyor. Bağlantıyı kontrol edip yeniden deneyin." : "Bağlantıyı ve uygulama sunucusunu kontrol edip yeniden deneyin."}</p>
          <p className={styles.err}>{error}</p>
          <button id="dashboard-retry" className={`btn btn-primary ${styles.retry}`} onClick={() => { setLoading(true); void load(); }} disabled={loading}>
            {loading ? "Yeniden deneniyor…" : "Yeniden dene"}
          </button>
        </div>
      )}
      {actionError && <p role="alert" className={styles.err}>{actionError}</p>}

      {!error && projects === null && (
        <div className={styles.grid} role="status" aria-label="Projeler yükleniyor" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={`${styles.card} ${styles.skeleton}`} />
          ))}
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className={`${styles.empty} glass fade-in`}>
          <span className={styles.emptyIcon}>🎬</span>
          <h3>Henüz proje yok</h3>
          <p>Yapay zeka ile bir video üret veya kendi videonu yükle.</p>
          <Link href="/create" className="btn btn-primary" id="empty-create">
            İlk Videonu Oluştur
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className={styles.grid}>
          {filtered.map((p, i) => (
            <article key={p.id} className={`${styles.card} fade-in`} style={{ animationDelay: `${i * 40}ms` }}>
              <Link href={`/editor/${p.id}`} className={styles.thumb} id={`open-${p.id}`}>
                {p.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl(p.thumbnail_url)} alt={p.name} />
                ) : (
                  <div className={styles.thumbPlaceholder}>
                    {p.status === "generating" ? <span className="spinner" /> : "🎞️"}
                  </div>
                )}
                {p.duration > 0 && <span className={styles.duration}>{formatTime(p.duration)}</span>}
                {p.origin === "veo" && <span className={styles.veo}>✦ Veo</span>}
              </Link>
              <div className={styles.meta}>
                <div className={styles.titleRow}>
                  <h3 title={p.name}>{p.name}</h3>
                  <StatusBadge status={p.status} />
                </div>
                <div className={styles.tags}>
                  {p.storyboard_progress && (p.status === "generating" || p.storyboard_progress.ready < p.storyboard_progress.total) &&
                    <span className="chip">🎬 {p.storyboard_progress.ready}/{p.storyboard_progress.total} sahne üretildi</span>}
                  {p.subtitle_language && <span className="chip">💬 {p.subtitle_language.toUpperCase()}</span>}
                  {p.operation_count > 0 && <span className="chip">✨ {p.operation_count} edit</span>}
                  {p.output_url && <span className="chip">✅ Render</span>}
                </div>
                {(p.source_url || p.output_url) && <div className={styles.downloads}>
                  {p.source_url && <a className="btn btn-sm" href={downloadUrl(p.source_url)} download>⬇ Kaynak</a>}
                  {p.output_url && <a className="btn btn-sm" href={downloadUrl(p.output_url)} download>⬇ Çıkış</a>}
                  {p.has_subtitles && <a className="btn btn-sm" href={`${API_URL}/api/projects/${p.id}/subtitles.srt`} download>⬇ SRT</a>}
                </div>}
                <div className={styles.footer}>
                  <span>{new Date(p.updated_at).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })}</span>
                  <button className="btn btn-ghost btn-sm btn-danger" onClick={() => remove(p)} id={`delete-${p.id}`} disabled={deleting !== null}>
                    {deleting === p.id ? "Siliniyor…" : "Sil"}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
