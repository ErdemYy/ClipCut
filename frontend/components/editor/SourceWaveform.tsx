"use client";

import { useCallback } from "react";
import { api, type Project } from "@/lib/api";
import { checkedWaveform, sourceReadKey } from "@/lib/media-reads";
import { useReadResource } from "@/lib/use-read-resource";
import ReadResourceStatus from "./ReadResourceStatus";
import styles from "./timeline.module.css";

export default function SourceWaveform({ project }: { project: Project }) {
  const key = sourceReadKey(project);
  const { id, duration, has_audio: hasAudio } = project;
  const read = useCallback(async (signal: AbortSignal) => checkedWaveform(await api.waveform(id, signal), duration, hasAudio), [id, duration, hasAudio]);
  // Local FFmpeg analysis has a 120s server bound; allow overhead without an endless spinner.
  const state = useReadResource(key, key, read, { enabled: project.status === "ready", timeoutMs: 130000 });
  return <section className={styles.readStack}>
    <ReadResourceStatus id="waveform-read" label="Kaynak ses dalgası" state={state} />
    {state.pending && !state.data && <p className={styles.note}>Yerel analiz bekleniyor; en fazla 130 saniye. Sayfadan ayrılmak sunucuda başlamış analizi durdurmayabilir.</p>}
    {state.data && (!state.data.has_audio ? <p className={styles.note} role="status">Kaynak videoda ses kanalı yok.</p> :
      <div className={styles.waveform} role="img" aria-label="Kaynak sesin zamana göre mono tepe genliği. Düzenlenmiş ses karışımı değildir.">
        <svg viewBox={`0 0 ${state.data.peaks.length} 64`} preserveAspectRatio="none" aria-hidden="true">
          {state.data.peaks.map((peak, i) => <line key={i} x1={i} x2={i} y1={32 - peak * 31} y2={32 + peak * 31} />)}
        </svg>
        <p className={styles.note}>Kaynak sesi · mono tepe genliği. Kesme/hız, müzik ve ayrı seslendirme bu dalgaya uygulanmaz; sessiz ses düz çizgi olabilir.</p>
      </div>)}
  </section>;
}
