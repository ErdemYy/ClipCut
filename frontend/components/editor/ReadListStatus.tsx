"use client";

import styles from "./ReadListStatus.module.css";

type Props = {
  id: string;
  label: string;
  empty: string;
  state: { items: unknown[]; pending: boolean; error: string | null; loaded: boolean; reload: () => Promise<void> };
};

export default function ReadListStatus({ id, label, empty, state }: Props) {
  const cached = state.loaded || state.items.length > 0;
  return (
    <section className={styles.status} aria-label={label}>
      <div>
        <strong>{label}</strong>
        {state.pending && <p role="status">{cached ? "Yenileniyor…" : "Yükleniyor…"}</p>}
      </div>
      <button type="button" id={`${id}-retry`} className="btn btn-ghost" disabled={state.pending}
        aria-label={`${label}: ${state.error ? "yeniden dene" : "yenile"}`}
        aria-describedby={state.error ? `${id}-error` : undefined} onClick={() => { void state.reload(); }}>
        {state.pending ? "Yükleniyor…" : state.error ? "Yeniden dene" : "Yenile"}
      </button>
      {state.error && <div id={`${id}-error`} role="alert" className={styles.message}>
        <p>{label} {cached ? "yenilenemedi" : "yüklenemedi"}. {state.error}</p>
        <p>{cached ? "Son bilinen liste korunuyor." : "Bağlantıyı kontrol edip yeniden deneyin."} Yeniden deneme yalnızca listeyi okur, yeni işlem başlatmaz.</p>
      </div>}
      {state.loaded && !state.pending && !state.error && state.items.length === 0 &&
        <p id={`${id}-empty`} role="status" className={styles.message}>{empty}</p>}
    </section>
  );
}
