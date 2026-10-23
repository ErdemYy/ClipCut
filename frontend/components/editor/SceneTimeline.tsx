"use client";

import { useEffect, useRef, useState } from "react";
import { mediaUrl, type Storyboard } from "@/lib/api";
import { MIN_SCENE_LENGTH, reorderScenes, sceneLayout, timelineDuration } from "@/lib/scene-timeline";
import styles from "./scene-timeline.module.css";

const TRANSITION = { cut: "Kesme", dissolve: "Çözünme", fade: "Kararmadan" };

export default function SceneTimeline({ draft, runtime, onChange, disabled, onPreview }: {
  draft: Storyboard; runtime: Storyboard; onChange: (draft: Storyboard) => void; disabled: boolean; onPreview: () => void;
}) {
  const [selectedId, setSelectedId] = useState(draft.scenes[0]?.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const previewAt = useRef<number | null>(null);
  const frame = useRef(0);
  const items = sceneLayout(draft.scenes, runtime.scenes);
  const total = timelineDuration(items);
  const selected = items.find((item) => item.scene.id === selectedId) ?? items[0];
  const index = items.indexOf(selected);
  const ready = selected?.state?.status === "ready" && !!selected.state.video_url;
  const { start = 0, end = 0, available = 0 } = selected ?? {};
  const url = mediaUrl(selected?.state?.video_url);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useEffect(() => {
    if (video.current) {
      video.current.pause();
      video.current.currentTime = Math.max(start, Math.min(end - 0.01, previewAt.current ?? start));
    }
    previewAt.current = null;
  }, [selected?.scene.id, start, end, url]);

  // timeupdate is too coarse (~4 Hz); follow frames so the preview stops exactly at the cut.
  const stopAt = (bound: number) => {
    cancelAnimationFrame(frame.current);
    const tick = () => {
      const el = video.current;
      if (!el || el.paused) { frame.current = 0; return; }
      if (el.currentTime >= bound) { el.pause(); el.currentTime = bound; frame.current = 0; return; }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  if (!selected) return null;
  const trim = (values: { trim_start?: number; trim_end?: number | null }) => onChange({ ...draft,
    scenes: draft.scenes.map((s) => s.id === selected.scene.id ? { ...s, ...values } : s) });
  const move = (direction: number) => {
    const neighbor = items[index + direction];
    if (neighbor) onChange({ ...draft, scenes: reorderScenes(draft.scenes, selected.scene.id, neighbor.scene.id, direction < 0 ? "before" : "after") });
  };

  return <section className={styles.timeline} aria-label="Görsel sahne zaman çizelgesi">
    <header className={styles.heading}><h3>Sahne zaman çizelgesi</h3><output>{items.length} sahne · {total.toFixed(2)} sn</output></header>
    <p className={styles.note}>Sahneleri sürükleyip bırakın veya sola/sağa taşıyın. Bu taslak zaman çizelgesidir; kırpma, sıralama ve geçişler kaydedilip yeniden birleştirildiğinde videoya uygulanır. AI üretimi gerekmez.</p>
    <div className={styles.distribution} role="img" aria-label={`Taslak süre dağılımı: ${total.toFixed(2)} saniye`}>
      {items.map((item, i) => <span key={item.scene.id} style={{ flex: item.weight }} className={item.scene.id === selected.scene.id ? styles.barSelected : ""} title={`${i + 1}. sahne: ${item.length.toFixed(2)} sn`} />)}
    </div>
    <div className={styles.ruler} aria-hidden="true"><span>0:00</span><span>{(total / 2).toFixed(2)} sn</span><span>{total.toFixed(2)} sn</span></div>
    <div className={styles.strip} role="list" aria-label="Sahneleri seç ve sırala">
      {items.map((item, i) => <div key={item.scene.id} role="listitem" data-scene-id={item.scene.id}
        draggable={!disabled} className={`${styles.item} ${over === item.scene.id ? styles.dropTarget : ""}`}
        style={{ width: Math.max(152, item.length * 28), opacity: dragging === item.scene.id ? 0.5 : 1 }}
        onDragStart={(e) => { if (disabled) { e.preventDefault(); return; } e.dataTransfer.setData("application/x-clipcut-scene", item.scene.id); e.dataTransfer.effectAllowed = "move"; setDragging(item.scene.id); }}
        onDragOver={(e) => { if (!disabled && e.dataTransfer.types.includes("application/x-clipcut-scene")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(item.scene.id); } }}
        onDragLeave={() => setOver(null)}
        onDragEnd={() => { setDragging(null); setOver(null); }}
        onDrop={(e) => {
          e.preventDefault(); setDragging(null); setOver(null);
          if (disabled) return;
          const source = e.dataTransfer.getData("application/x-clipcut-scene");
          const rect = e.currentTarget.getBoundingClientRect();
          onChange({ ...draft, scenes: reorderScenes(draft.scenes, source, item.scene.id, e.clientX > rect.left + rect.width / 2 ? "after" : "before") });
        }}>
        <button type="button" className={`${styles.sceneButton} ${item.scene.id === selected.scene.id ? styles.selected : ""}`}
          aria-pressed={item.scene.id === selected.scene.id} onClick={() => { video.current?.pause(); previewAt.current = null; setSelectedId(item.scene.id); }}
          aria-label={`${i + 1}. sahneyi seç: ${item.scene.title}, ${item.length.toFixed(2)} saniye`}>
          {item.state?.thumbnail_url ?
            // Dynamic local JPEGs, not public/static Next images.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl(item.state.thumbnail_url)} alt="" draggable={false} loading="lazy" /> : <span className={styles.placeholder}>{i + 1}</span>}
          <strong>{i + 1}. {item.scene.title}</strong>
          {item.incoming > 0 && <small className={styles.transition}>{TRANSITION[item.scene.transition]} · {item.incoming.toFixed(2)} sn</small>}
          <small>{item.offset.toFixed(2)} – {(item.offset + item.length).toFixed(2)} sn · {item.length.toFixed(2)} sn</small>
          <small>{item.state?.status === "ready" ? "Hazır" : item.state?.status === "generating" ? "Üretiliyor" : "Önce sahneyi üretin"}</small>
        </button>
      </div>)}
    </div>
    <div className={styles.controls}>
      <strong>Seçili: {index + 1}. {selected.scene.title}</strong>
      <div className={styles.actions}>
        <button className="btn btn-sm" disabled={disabled || index === 0} onClick={() => move(-1)}>← Sola taşı</button>
        <button className="btn btn-sm" disabled={disabled || index === items.length - 1} onClick={() => move(1)}>Sağa taşı →</button>
      </div>
      {ready ? <>
        <video ref={video} src={url} poster={mediaUrl(selected.state?.thumbnail_url)} controls playsInline preload="metadata"
          aria-label="Seçili sahne önizlemesi" onLoadedMetadata={(e) => { e.currentTarget.currentTime = start; }}
          onPlay={(e) => { onPreview(); if (e.currentTarget.currentTime < start || e.currentTarget.currentTime >= end) e.currentTarget.currentTime = start; stopAt(end); }}
          onPause={() => cancelAnimationFrame(frame.current)}
          onSeeking={(e) => { const t = e.currentTarget.currentTime; if (t < start || t > end + 0.01) e.currentTarget.currentTime = Math.max(start, Math.min(end - 0.01, t)); }} />
        <div className={styles.actions}><button className="btn btn-sm" onClick={() => { if (video.current) { video.current.currentTime = start; video.current.play().catch(() => {}); } }}>Kırpılan aralığı oynat</button></div>
        <fieldset disabled={disabled} className={styles.trim}>
          <legend>Sahneyi kırp · en az {MIN_SCENE_LENGTH} sn</legend>
          <label>Başlangıç · {start.toFixed(2)} sn<input id="scene-trim-start" type="range" min={0} max={Math.max(0, end - MIN_SCENE_LENGTH)} step="0.01" value={start}
            onChange={(e) => { const value = Math.min(Number(e.target.value), end - MIN_SCENE_LENGTH); previewAt.current = value; trim({ trim_start: value }); }} /></label>
          <label>Bitiş · {end.toFixed(2)} sn<input id="scene-trim-end" type="range" min={start + MIN_SCENE_LENGTH} max={available} step="0.01" value={end}
            onChange={(e) => { const value = Math.max(start + MIN_SCENE_LENGTH, Math.min(available, Number(e.target.value))); previewAt.current = value - 0.04; trim({ trim_end: Math.abs(value - available) < 0.001 ? null : value }); }} /></label>
          <output>{start.toFixed(2)} – {end.toFixed(2)} sn · kullanılacak {selected.length.toFixed(2)} / {available.toFixed(2)} sn</output>
        </fieldset>
      </> : <p className={styles.note}>Önizleme ve kırpma için bu sahnenin üretilmiş olması gerekir.</p>}
      <button className="btn btn-sm" disabled={disabled || (!(selected.scene.trim_start > 0) && selected.scene.trim_end == null)} onClick={() => trim({ trim_start: 0, trim_end: null })}>Kırpmayı sıfırla</button>
      <p className={styles.note}>Kırpma ses ve altyazıyı da keser; yeni kelimeler üretmez. Bir kelimenin ortasından keserseniz konuşma yarım kalabilir. Değişiklikleri Sahneler panelinden kaydedip yeniden birleştirin.</p>
    </div>
  </section>;
}
