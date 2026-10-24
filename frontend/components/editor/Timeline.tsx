"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, formatTime, type LayerTiming, type Operation, type Project, type TimelineInfo } from "@/lib/api";
import { adjustLayer, layerTimingError, outputToSource, sourceToOutput, timelineLayers, visibleLayer, type LayerGesture, type TimelineLayer } from "@/lib/layer-timeline";
import SourceWaveform from "./SourceWaveform";
import styles from "./timeline.module.css";

type Props = { project: Project; timeline: TimelineInfo; time: number; onSeek: (t: number) => void;
  setProject: (project: Project) => void; onTimeline: (timeline: TimelineInfo) => void; notify: (text: string, error?: boolean) => void };
type Draft = { base: string; operations: Operation[]; total: number; edits: Record<number, LayerTiming> };
type Drag = { pointerId: number; x: number; width: number; layer: TimelineLayer; mode: LayerGesture; base: string; before: Draft | null };

export default function Timeline({ project, timeline, time, onSeek, setProject, onTimeline, notify }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selection, setSelection] = useState<{ base: string; index: number } | null>(null);
  const [pending, setPending] = useState(false);
  const drag = useRef<Drag | null>(null);
  const incoming = project.timeline_revision ?? timeline.revision ?? JSON.stringify([project.source_url, project.duration, project.plan]);
  const current = !project.timeline_revision || timeline.revision === project.timeline_revision;
  const base = draft?.base ?? incoming;
  const total = draft?.total ?? timeline.exact_output_duration ?? timeline.output_duration;
  const operations = draft?.operations ?? project.plan?.operations ?? [];
  const layers = timelineLayers(operations).map((layer) => ({ ...layer, ...draft?.edits[layer.index] }));
  const music = operations.find((op) => op.type === "music");
  const edits = Object.values(draft?.edits ?? {});
  const dirty = edits.length > 0;
  const conflict = !!draft && draft.base !== incoming;
  const locked = pending || conflict || !current || project.status !== "ready" || total < 0.1;
  const selected = selection?.base === base ? layers.find((layer) => layer.index === selection.index) : undefined;
  const error = layerTimingError(edits, total);
  const selectedError = selected ? layerTimingError([selected], total) : null;
  const sourceTotal = project.duration || 1;
  const outputTime = sourceToOutput(time, timeline);
  const pct = (value: number) => `${Math.min(100, Math.max(0, value / sourceTotal * 100))}%`;

  const change = (timing: LayerTiming) => {
    if (locked) return;
    setDraft((previous) => {
      const state = previous ?? { base: incoming, operations: project.plan?.operations ?? [], total: timeline.exact_output_duration ?? timeline.output_duration, edits: {} };
      const original = timelineLayers(state.operations).find((layer) => layer.index === timing.index);
      if (!original) return previous;
      const next = { ...state.edits, [timing.index]: timing };
      if (Math.abs(original.start - timing.start) < 1e-6 && Math.abs(original.duration - timing.duration) < 1e-6) delete next[timing.index];
      return Object.keys(next).length ? { ...state, edits: next } : null;
    });
  };
  const begin = (e: PointerEvent<HTMLButtonElement>, layer: TimelineLayer, mode: LayerGesture) => {
    if (locked || e.button !== 0) return;
    e.preventDefault(); e.currentTarget.focus();
    const lane = e.currentTarget.closest('[data-layer-lane]')!.getBoundingClientRect();
    drag.current = { pointerId: e.pointerId, x: e.clientX, width: lane.width, layer, mode, base, before: draft };
    setSelection({ base, index: layer.index });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId || state.base !== base || locked || state.width <= 0 || Math.abs(e.clientX - state.x) < 2) return;
    const delta = Math.round((e.clientX - state.x) / state.width * total * 100) / 100;
    change(adjustLayer(state.layer, state.mode, delta, total));
  };
  const finish = (e: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId) return;
    drag.current = null;
    if (cancel) setDraft(state.before);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const keyboard = (e: KeyboardEvent<HTMLButtonElement>, layer: TimelineLayer, mode: LayerGesture) => {
    if (e.key === "Escape" && drag.current) { setDraft(drag.current.before); drag.current = null; return; }
    if (locked || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    setSelection({ base, index: layer.index });
    change(adjustLayer(layer, mode, (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.01 : 0.1), total));
  };
  const save = async () => {
    if (!draft || !dirty || error || locked) return;
    setPending(true);
    try {
      const result = await api.setLayerTimings(project.id, draft.base, edits);
      setProject(result); setDraft(null); setSelection(null); notify("Katman zamanları kaydedildi; tek edit adımı olarak geri alınabilir.");
    } catch (err) {
      notify((err as Error).message, true);
      try { setProject(await api.project(project.id)); onTimeline(await api.timeline(project.id)); } catch { /* Keep the draft offline. */ }
    } finally { setPending(false); }
  };
  const reload = async () => {
    setPending(true);
    try { const latest = await api.project(project.id); const info = await api.timeline(project.id); setProject(latest); onTimeline(info); setDraft(null); setSelection(null); }
    catch (err) { notify((err as Error).message, true); }
    finally { setPending(false); }
  };
  const undo = async () => {
    setPending(true);
    try { setProject(await api.undo(project.id)); setSelection(null); notify("Kaydedilen son edit adımı geri alındı."); }
    catch (err) { notify((err as Error).message, true); }
    finally { setPending(false); }
  };

  return <section className={styles.timeline} aria-labelledby="timeline-title">
    <header className={styles.header}><h3 id="timeline-title">Zaman çizelgesi</h3>
      <span>{formatTime(sourceTotal)} kaynak → {formatTime(timeline.output_duration)} çıktı · ×{timeline.speed}</span>
    </header>
    <section className={styles.source} aria-label="Kaynak zaman çizelgesi">
      <h4>Kaynak video ve ses</h4>
      <div className={styles.sourceBand} aria-label="Tutulan kaynak aralıkları">
        {timeline.segments.map(([start, end], i) => <span className={styles.keep} key={i} style={{ left: pct(start), width: pct(end - start) }} title={`${start.toFixed(2)}–${end.toFixed(2)} sn`} />)}
        <span className={styles.cursor} style={{ left: pct(time) }} />
      </div>
      <SourceWaveform project={project} />
      <span className={styles.note}>Altyazı aralıkları · kaynak saati · salt okunur</span>
      <div className={styles.sourceBand} aria-label="Kaynak saatinde altyazı aralıkları">
        {(project.subtitles?.segments ?? []).map((segment) => {
          const start = Math.min(sourceTotal, Math.max(0, segment.start));
          const end = Math.min(sourceTotal, Math.max(0, segment.end));
          return end > start ? <span key={segment.id} className={styles.subtitleCue} style={{ left: pct(start), width: pct(end - start) }} title={segment.text} /> : null;
        })}
        <span className={styles.cursor} style={{ left: pct(time) }} />
      </div>
      <label className={styles.label} htmlFor="timeline-source-seek">Kaynak konumu · {Math.max(0, time).toFixed(2)} sn
        <input id="timeline-source-seek" type="range" min="0" max={sourceTotal} step="0.01" value={Math.min(sourceTotal, Math.max(0, time))} onChange={(e) => onSeek(Number(e.target.value))} />
      </label>
      <p className={styles.note}>{timeline.segments.length} tutulan parça · {Math.max(0, sourceTotal - timeline.segments.reduce((sum, [a, b]) => sum + b - a, 0)).toFixed(2)} sn kesim. Kaynak oynatıcı kesilmemiş görüntüyü gösterir.</p>
    </section>
    <section className={styles.output} aria-label="Düzenlenebilir çıktı katmanları">
      <h4>Çıktı katmanları · {total.toFixed(2)} sn</h4>
      <p className={styles.note} id="layer-help">Metin/B-roll ortasından taşıyın, kenar tutamaçlarından süresini değiştirin. Ok tuşları 0.1 sn, Shift + ok 0.01 sn değiştirir. Sürüklemek yerine aşağıdaki seçim ve sayı alanlarını da kullanabilirsiniz. Buradaki zamanlar kesme/hız sonrası çıktı saatidir.</p>
      {!current && <p className={styles.note} role="status">Zaman çizelgesi güncelleniyor…</p>}
      {conflict && <p className={styles.error} role="alert">Kaynak/edit değişti. Eski taslak korunuyor; üzerine yazılmaz. Güncel veriyi yükleyip tekrar düzenleyin.</p>}
      <div className={styles.ruler}><span>0 sn</span><span>{total.toFixed(2)} sn çıktı</span></div>
      {music && <div className={styles.laneRow}><span className={styles.laneLabel}>Müzik · salt okunur</span>
        <div className={styles.lane}><span className={styles.music}>♪ {String(music.track)}</span></div>
      </div>}
      {layers.map((layer) => {
        const span = visibleLayer(layer, total);
        return <div className={styles.laneRow} key={layer.index}>
          <span className={styles.laneLabel}>{layer.type === "text" ? "Metin" : "B-roll"} · {layer.label}</span>
          <div className={styles.lane} data-layer-lane={layer.index}>
            {span ? <div className={`${styles.bar} ${selected?.index === layer.index ? styles.selected : ""}`} style={{ left: `${span.left}%`, width: `${span.width}%` }}>
              {(["start", "move", "end"] as LayerGesture[]).map((mode) => <button key={mode} type="button"
                className={mode === "move" ? styles.move : styles.handle} disabled={locked} aria-describedby="layer-help"
                aria-label={`${layer.type === "text" ? "Metin" : "B-roll"}: ${layer.label} · ${mode === "move" ? "taşı" : mode === "start" ? "başlangıcı değiştir" : "bitişi değiştir"}`}
                title={`${layer.start.toFixed(2)}–${(layer.start + layer.duration).toFixed(2)} sn`}
                onClick={() => setSelection({ base, index: layer.index })} onPointerDown={(e) => begin(e, layer, mode)}
                onPointerMove={move} onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)}
                onLostPointerCapture={(e) => finish(e, true)} onKeyDown={(e) => keyboard(e, layer, mode)}>
                {mode === "move" ? layer.label : "│"}
              </button>)}
            </div> : <span className={styles.outside}>Çıktı süresinin dışında; listeden seçip düzeltin.</span>}
            {outputTime !== null && total > 0 && <span className={styles.cursor} style={{ left: `${Math.min(100, outputTime / total * 100)}%` }} />}
          </div>
        </div>;
      })}
      {!layers.length && <p className={styles.note}>Düzenlenecek metin/B-roll yok. AI Edit veya B-roll panelinden katman ekleyin; bu çizelge kendiliğinden üretim başlatmaz.</p>}
      <label className={styles.label} htmlFor="timeline-layer-select">Katman seç (kısa katmanlar için de kullanılabilir)
        <select id="timeline-layer-select" className="select" disabled={locked || !layers.length} value={selected?.index ?? ""}
          onChange={(e) => setSelection(e.target.value === "" ? null : { base, index: Number(e.target.value) })}>
          <option value="">Katman seçin</option>
          {layers.map((layer) => <option key={layer.index} value={layer.index}>{layer.index + 1}. {layer.type === "text" ? "Metin" : "B-roll"} · {layer.label}</option>)}
        </select>
      </label>
      {selected && <fieldset className={styles.inspector} disabled={locked} aria-describedby="layer-help">
        <legend>{selected.label}</legend>
        <label>Başlangıç (çıktı sn)<input id="layer-start" className="input" type="number" min="0" max={total} step="0.01" value={selected.start}
          onChange={(e) => change({ index: selected.index, start: Number(e.target.value), duration: selected.duration })} /></label>
        <label>Süre (sn)<input id="layer-duration" className="input" type="number" min="0.1" max={Math.min(600, total)} step="0.01" value={selected.duration}
          onChange={(e) => change({ index: selected.index, start: selected.start, duration: Number(e.target.value) })} /></label>
        <p className={styles.note} role="status">Başlangıç: {selected.start.toFixed(2)} · süre: {selected.duration.toFixed(2)} · bitiş: {(selected.start + selected.duration).toFixed(2)} çıktı sn</p>
        <button className="btn btn-sm" onClick={() => { const source = outputToSource(selected.start, timeline); if (source !== null) onSeek(source); }}>Kaynakta başlangıca git</button>
      </fieldset>}
      {(error || selectedError) && <p className={styles.error} role="alert">{error || selectedError}</p>}
      <div className={styles.actions}>
        <button id="timeline-save" className="btn btn-primary btn-sm" disabled={locked || !dirty || !!error} onClick={save}>{pending ? "İşleniyor…" : "Katman zamanlarını kaydet"}</button>
        <button id="timeline-discard" className="btn btn-sm" disabled={pending} onClick={reload}>{draft ? "Taslağı at / güncel veriyi yükle" : "Zaman çizelgesini yenile"}</button>
        <button id="timeline-undo" className="btn btn-sm" disabled={pending || dirty || !current || project.status !== "ready" || !project.can_undo} onClick={undo}>Kaydedilen son edit adımını geri al</button>
      </div>
      <p className={styles.note} role="status">{dirty ? `${edits.length} katmanda kaydedilmemiş değişiklik var. ` : ""}Kaydetmeden render değişmez; sayfadan ayrılırsanız taslak kaybolabilir. Tam render dosyası korunur; kesin sonucu kısa render önizlemesinde kontrol edin. Geçişte kaynakta başlangıca git, önceki parçayı gösterir. Müzik/SFX/sahne kesimleri bu katman düzenleyicisinden değişmez.</p>
    </section>
  </section>;
}
