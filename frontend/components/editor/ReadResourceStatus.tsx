"use client";

import styles from "./ReadListStatus.module.css";

type Props = { id: string; label: string; state: {
  enabled: boolean; data: unknown | null; current: boolean; pending: boolean; error: string | null; reload: () => Promise<unknown>;
} };

export default function ReadResourceStatus({ id, label, state }: Props) {
  return <section className={styles.status} aria-label={`${label} yükleme durumu`}>
    <div><strong>{label}</strong>{state.pending && <p role="status">{state.data ? "Yenileniyor…" : "Yükleniyor…"}</p>}
      {!state.enabled && <p role="status">Kaynak hazır olduğunda yüklenecek.</p>}</div>
    <button type="button" id={`${id}-retry`} className="btn btn-ghost" disabled={!state.enabled || state.pending}
      aria-label={`${label}: ${state.error ? "yeniden dene" : "yenile"}`} aria-describedby={state.error ? `${id}-error` : undefined}
      onClick={() => { void state.reload(); }}>{state.pending ? "Yükleniyor…" : state.error ? "Yeniden dene" : "Yenile"}</button>
    {state.error && <div className={styles.message} id={`${id}-error`} role="alert">
      <p>{label} yüklenemedi. {state.error}</p>
      <p>{state.data ? "Son yüklenen veri korunuyor." : "Bağlantıyı kontrol edip yeniden deneyin."} Yeniden deneme yalnızca veriyi okur; render veya üretim başlatmaz.</p>
    </div>}
    {state.data !== null && !state.current && <p className={styles.message} role="status">Önceki düzenlemenin verisi gösteriliyor; güncel değil ve katman düzenleme kapalı.</p>}
  </section>;
}
