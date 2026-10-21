"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, api, mediaUrl, type Library, type LibraryItem, type Operation, type Project } from "@/lib/api";
import styles from "./editor-parts.module.css";

type Props = {
  project: Project;
  setProject: (p: Project) => void;
  library: Library | null;
  notify: (t: string, e?: boolean) => void;
};

export default function AudioPanel({ project, setProject, library, notify }: Props) {
  const [own, setOwn] = useState<LibraryItem[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [sfxAt, setSfxAt] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ops = project.plan?.operations ?? [];
  const music = ops.find((o) => o.type === "music") as Operation | undefined;
  const volume = ops.find((o) => o.type === "volume") as Operation | undefined;

  useEffect(() => {
    api.projectAudio(project.id).then(setOwn).catch(() => {});
    return () => audioRef.current?.pause();
  }, [project.id]);

  const preview = (item: LibraryItem) => {
    audioRef.current?.pause();
    if (playing === item.id) {
      setPlaying(null);
      return;
    }
    const url = item.url.startsWith("/media") ? mediaUrl(item.url)! : `${API_URL}${item.url}`;
    const a = new Audio(url);
    a.volume = 0.6;
    a.play().catch(() => {});
    a.onended = () => setPlaying(null);
    audioRef.current = a;
    setPlaying(item.id);
  };

  const save = async (operations: Operation[]) => {
    setProject({ ...project, plan: { operations } });
    try {
      setProject(await api.setPlan(project.id, { operations }));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const upsert = (type: string, patch: Record<string, unknown>, defaults: Record<string, unknown>) => {
    const existing = ops.find((o) => o.type === type);
    const next = { ...(existing ?? { type, ...defaults }), ...patch } as Operation;
    return save(existing ? ops.map((o) => (o.type === type ? next : o)) : [...ops, next]);
  };

  const selectTrack = (id: string) =>
    music?.track === id ? save(ops.filter((o) => o.type !== "music")) : upsert("music", { track: id }, { volume: 0.18, ducking: true, fade_in: 1, fade_out: 2 });

  const uploadOwn = async (file: File) => {
    try {
      const item = await api.uploadAudio(project.id, file);
      setOwn((o) => [...o.filter((x) => x.id !== item.id), item]);
      await upsert("music", { track: item.id }, { volume: 0.18, ducking: true, fade_in: 1, fade_out: 2 });
      notify("Müzik yüklendi ve eklendi");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const tracks = [...(library?.music ?? []), ...own.map((o) => ({ ...o, mood: "Senin yüklediğin" }))];

  return (
    <div className={styles.section}>
      <div className={styles.planHead}>
        <h4>Fon müziği</h4>
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()} id="audio-upload">
          ⬆ Müzik yükle
        </button>
        <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && uploadOwn(e.target.files[0])} />
      </div>
      <ul className={styles.trackList}>
        {tracks.map((t) => (
          <li key={t.id} className={`${styles.trackItem} ${music?.track === t.id ? styles.trackOn : ""}`}>
            <button className={styles.playBtn} onClick={() => preview(t)} title="Dinle" id={`audio-preview-${t.id}`}>
              {playing === t.id ? "❚❚" : "▶"}
            </button>
            <div onClick={() => selectTrack(t.id)} className={styles.trackMeta} id={`audio-select-${t.id}`}>
              <strong>{t.label}</strong>
              <small>{t.mood}</small>
            </div>
            <span className={styles.trackCheck}>{music?.track === t.id ? "✓" : "+"}</span>
          </li>
        ))}
      </ul>

      {music && (
        <div className={styles.sliderBox}>
          <label className="label">Müzik seviyesi · %{Math.round(Number(music.volume) * 100)}</label>
          <input
            type="range" min={0} max={0.6} step={0.01} value={Number(music.volume)} className={styles.slider} id="music-volume"
            onChange={(e) => upsert("music", { volume: Number(e.target.value) }, {})}
          />
          <label className={styles.check}>
            <input type="checkbox" checked={Boolean(music.ducking)} onChange={(e) => upsert("music", { ducking: e.target.checked }, {})} id="music-ducking" />
            Konuşmada müziği otomatik kıs (ducking)
          </label>
        </div>
      )}

      <div className={styles.sliderBox}>
        <label className="label">Konuşma sesi · x{Number(volume?.gain ?? 1).toFixed(2)}</label>
        <input
          type="range" min={0} max={2.5} step={0.05} value={Number(volume?.gain ?? 1)} className={styles.slider} id="voice-volume"
          onChange={(e) => upsert("volume", { gain: Number(e.target.value) }, { normalize: false })}
        />
        <label className={styles.check}>
          <input type="checkbox" checked={Boolean(volume?.normalize)} onChange={(e) => upsert("volume", { normalize: e.target.checked }, { gain: 1 })} id="voice-normalize" />
          Ses seviyesini normalize et (-16 LUFS)
        </label>
      </div>

      <div className={styles.planHead}>
        <h4>Ses efektleri</h4>
        <div className={styles.row}>
          <label className={styles.muted} htmlFor="sfx-at">Saniye</label>
          <input id="sfx-at" type="number" min={0} step={0.1} value={sfxAt} onChange={(e) => setSfxAt(Number(e.target.value))} className={`input ${styles.numInput}`} />
        </div>
      </div>
      <div className={styles.sfxGrid}>
        {(library?.sfx ?? []).map((s) => (
          <div key={s.id} className={styles.sfx}>
            <button className={styles.playBtn} onClick={() => preview(s)} id={`sfx-preview-${s.id}`}>{playing === s.id ? "❚❚" : "▶"}</button>
            <span>{s.label}</span>
            <button
              className="btn btn-sm"
              id={`sfx-add-${s.id}`}
              onClick={() => save([...ops, { type: "sfx", track: s.id, at: sfxAt, volume: 0.8 }]).then(() => notify(`${s.label} ${sfxAt}. saniyeye eklendi`))}
            >
              +
            </button>
          </div>
        ))}
      </div>
      <p className={styles.muted}>Efekt zamanı, düzenlenmiş (çıktı) videonun saniyesidir.</p>
    </div>
  );
}
