"use client";

import { useEffect, useState } from "react";
import { api, type Project, type Waveform } from "@/lib/api";
import styles from "./timeline.module.css";

export default function SourceWaveform({ project }: { project: Project }) {
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data?: Waveform; error?: string } | null>(null);
  const key = JSON.stringify([project.id, project.source_url, project.duration, project.has_audio, retry]);
  const projectId = project.id;
  const ready = project.status === "ready";
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    api.waveform(projectId, controller.signal).then((data) => {
      if (!controller.signal.aborted) setLoaded({ key, data });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setLoaded({ key, error: error.message });
    });
    return () => controller.abort();
  }, [key, projectId, ready]);
  if (!loaded || loaded.key !== key) return <p className={styles.note} role="status">Kaynak ses dalgası yerel olarak hazırlanıyor…</p>;
  if (loaded.error) return <div><p className={styles.error} role="alert">{loaded.error}</p><button className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>Ses dalgasını yeniden yükle</button></div>;
  if (!loaded.data?.has_audio) return <p className={styles.note}>Kaynak videoda ses kanalı yok.</p>;
  return <div className={styles.waveform} role="img" aria-label="Kaynak sesin zamana göre mono tepe genliği. Düzenlenmiş ses karışımı değildir.">
    <svg viewBox={`0 0 ${loaded.data.peaks.length} 64`} preserveAspectRatio="none" aria-hidden="true">
      {loaded.data.peaks.map((peak, i) => <line key={i} x1={i} x2={i} y1={32 - peak * 31} y2={32 + peak * 31} />)}
    </svg>
    <p className={styles.note}>Kaynak sesi · mono tepe genliği. Kesme/hız, müzik ve ayrı seslendirme bu dalgaya uygulanmaz; sessiz ses düz çizgi olabilir.</p>
  </div>;
}
