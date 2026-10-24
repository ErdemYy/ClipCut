"use client";

import { useMemo, useState } from "react";
import { api, formatTime, type Project, type Segment } from "@/lib/api";
import { mergeSubtitle, prepareSubtitleSegments, shiftSubtitles, splitSubtitle, subtitleBounds, subtitleText, subtitleTimingError } from "@/lib/subtitle-timing";
import pub from "./publishing.module.css";

type Draft = { base: string; revision?: string; original: Segment[]; segments: Segment[]; history: Segment[][] };
type Props = { project: Project; setProject: (project: Project) => void; notify: (text: string, error?: boolean) => void;
  seek: (time: number) => void; time: number; disabled: boolean; onDirtyChange: (dirty: boolean) => void };

export default function SubtitleTimingEditor({ project, setProject, notify, seek, time, disabled, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [offset, setOffset] = useState(0);
  const [splitPoints, setSplitPoints] = useState<Record<number, number>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const base = project.subtitle_revision ?? JSON.stringify([project.source_url, project.voiceover_url, project.subtitles]);
  const savedSegments = useMemo(() => prepareSubtitleSegments(project.subtitles?.segments ?? []), [project.subtitles]);
  const segments = draft?.segments ?? savedSegments;
  const limit = project.subtitle_time_limit ?? project.duration;
  const dirty = useMemo(() => !!draft && JSON.stringify(draft.segments) !== JSON.stringify(draft.original), [draft]);
  const conflict = !!draft && draft.base !== base;
  const error = useMemo(() => subtitleTimingError(segments, limit), [segments, limit]);
  const locked = disabled || saving || conflict;

  const change = (next: Segment[]) => {
    const current = draft ?? { base, revision: project.subtitle_revision, original: segments, segments, history: [] };
    const nextDirty = JSON.stringify(next) !== JSON.stringify(current.original);
    setDraft({ ...current, segments: next, history: [...current.history, current.segments].slice(-30) });
    onDirtyChange(nextDirty);
  };
  const update = (index: number, segment: Segment) => change(segments.map((row, i) => i === index ? segment : row));
  const discard = () => { setDraft(null); onDirtyChange(false); };
  const undo = () => {
    if (!draft?.history.length) return;
    const previous = draft.history[draft.history.length - 1];
    setDraft({ ...draft, segments: previous, history: draft.history.slice(0, -1) });
    onDirtyChange(JSON.stringify(previous) !== JSON.stringify(draft.original));
  };
  const save = async () => {
    if (!draft || error || conflict) return;
    setSaving(true);
    try {
      const result = await api.saveSubtitles(project.id, segments, draft.revision);
      setProject(result); discard(); notify("Altyazı metinleri ve kelime zamanları kaydedildi.");
    } catch (err) {
      notify((err as Error).message, true);
      // Refresh the saved baseline after a stale-save rejection, never the draft.
      try { setProject(await api.project(project.id)); } catch { /* Preserve draft offline. */ }
    }
    finally { setSaving(false); }
  };
  const shift = () => {
    try { change(shiftSubtitles(segments, offset, limit)); }
    catch (err) { notify((err as Error).message, true); }
  };
  const reload = async () => {
    setSaving(true);
    try { setProject(await api.project(project.id)); discard(); }
    catch (err) { notify((err as Error).message, true); }
    finally { setSaving(false); }
  };

  return <section className={pub.results} aria-labelledby="subtitle-timing-title">
    <h4 id="subtitle-timing-title">Metin ve zamanlama · {segments.length} satır</h4>
    {project.subtitles?.mock && <p className={pub.note}>Demo altyazısı: metin ve zamanlar gerçek konuşmayı temsil etmeyebilir.</p>}
    <p id="subtitle-timing-help" className={pub.note}>Zamanlar kaynak saatindedir; kesme/hız render sırasında uygulanır. Satır süresini değiştirince kelime zamanları orantılı taşınır. Metin değişince kelime süreleri yaklaşık yeniden dağıtılır; bölme/birleştirme mevcut süreleri korur.</p>
    <p className={pub.note}>Taslak, Kaydet sonrası önizleme ve dışa aktarmaya uygulanır. Kaynak transkripti ve video değiştirilmez. Stiller uzun satırları görsel olarak tekrar bölebilir; SRT/VTT kaydedilen satır sınırlarını korur.</p>
    {conflict && <p role="alert" className={pub.error}>Kaynak veya kaydedilmiş altyazılar değişti. Taslağınız korunuyor; güncel veriyi yüklemek için “Taslağı at / güncel veriyi yükle” düğmesini kullanın.</p>}
    {error && <p id="subtitle-timing-error" role="alert" className={pub.error}>{error}</p>}
    <fieldset className={pub.settings} disabled={locked} aria-describedby="subtitle-timing-help">
      <legend>Tüm altyazıyı kaydır</legend>
      <label htmlFor="subtitle-offset">Kaydırma (sn) · eksi: erkene, artı: geçe
        <input id="subtitle-offset" className="input" type="number" step="0.001" value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
      </label>
      <button id="subtitle-shift" className="btn btn-sm" onClick={shift} disabled={!segments.length || offset === 0}>Taslağa uygula</button>
    </fieldset>
    <div className={pub.actions}>
      <button id="sub-save" className="btn btn-primary btn-sm" disabled={locked || !dirty || !!error} onClick={save}>{saving ? "Kaydediliyor…" : "Metin ve zamanları kaydet"}</button>
      <button className="btn btn-sm" disabled={locked || !draft?.history.length} onClick={undo}>Taslak adımını geri al</button>
      <button id="subtitle-discard" className="btn btn-sm" disabled={saving || !draft} onClick={reload}>Taslağı at / güncel veriyi yükle</button>
      <a className="btn btn-sm" href={api.subtitleExportUrl(project.id, "srt")} id="sub-export-srt">Kaydedilmiş SRT</a>
      <a className="btn btn-sm" href={api.subtitleExportUrl(project.id, "vtt")} id="sub-export-vtt">Kaydedilmiş VTT</a>
    </div>
    {dirty && <p role="status" className={pub.note}>Kaydedilmemiş değişiklikler var. Sekme/sayfa değiştirirseniz taslak kaybolabilir.</p>}
    {segments.map((segment, index) => <fieldset className={pub.settings} key={segment.id} disabled={locked}
      aria-describedby={error ? "subtitle-timing-error" : "subtitle-timing-help"}>
      <legend>{index + 1}. satır · {formatTime(segment.start)}{time >= segment.start && time <= segment.end ? " · oynatılıyor" : ""}</legend>
      <label htmlFor={`sub-text-${segment.id}`}>Metin
        <textarea id={`sub-text-${segment.id}`} className="textarea" rows={2} value={segment.text} onChange={(e) => update(index, subtitleText(segment, e.target.value))} />
      </label>
      <label htmlFor={`subtitle-start-${segment.id}`}>Başlangıç (sn)
        <input id={`subtitle-start-${segment.id}`} className="input" type="number" step="0.001" min="0" max={limit} value={segment.start} onChange={(e) => update(index, subtitleBounds(segment, Number(e.target.value), segment.end))} />
      </label>
      <label htmlFor={`subtitle-end-${segment.id}`}>Bitiş (sn)
        <input id={`subtitle-end-${segment.id}`} className="input" type="number" step="0.001" min="0" max={limit} value={segment.end} onChange={(e) => update(index, subtitleBounds(segment, segment.start, Number(e.target.value)))} />
      </label>
      <button className="btn btn-sm" onClick={() => seek(segment.start)}>Kaynakta bu satıra git</button>
      {segment.words.length > 1 && <label htmlFor={`subtitle-split-${segment.id}`}>Bu kelimeden sonra böl
        <select id={`subtitle-split-${segment.id}`} className="select" value={Math.min(splitPoints[segment.id] ?? 1, segment.words.length - 1)}
          onChange={(e) => setSplitPoints((current) => ({ ...current, [segment.id]: Number(e.target.value) }))}>
          {segment.words.slice(0, -1).map((word, i) => <option key={i} value={i + 1}>{i + 1}. {word.text}</option>)}
        </select>
      </label>}
      <div className={pub.actions}>
        <button className="btn btn-sm" disabled={segment.words.length < 2 || !!error} onClick={() => change(splitSubtitle(segments, index, Math.min(splitPoints[segment.id] ?? 1, segment.words.length - 1)))}>Satırı böl</button>
        <button className="btn btn-sm" disabled={index === segments.length - 1 || !!error} onClick={() => change(mergeSubtitle(segments, index))}>Sonraki satırla birleştir</button>
      </div>
      <details onToggle={(e) => { const open = e.currentTarget.open; setExpanded((current) => ({ ...current, [segment.id]: open })); }}>
        <summary>Kelime zamanları · {segment.words.length} kelime</summary>
        {expanded[segment.id] && segment.words.map((word, wordIndex) => <div className={pub.cover} key={wordIndex}>
          <strong>{wordIndex + 1}. {word.text}</strong>
          <label htmlFor={`word-start-${segment.id}-${wordIndex}`}>{word.text} başlangıç (sn)
            <input id={`word-start-${segment.id}-${wordIndex}`} className="input" type="number" step="0.001" min={segment.start} max={segment.end} value={word.start}
              onChange={(e) => update(index, { ...segment, words: segment.words.map((w, i) => i === wordIndex ? { ...w, start: Number(e.target.value) } : w) })} />
          </label>
          <label htmlFor={`word-end-${segment.id}-${wordIndex}`}>{word.text} bitiş (sn)
            <input id={`word-end-${segment.id}-${wordIndex}`} className="input" type="number" step="0.001" min={segment.start} max={segment.end} value={word.end}
              onChange={(e) => update(index, { ...segment, words: segment.words.map((w, i) => i === wordIndex ? { ...w, end: Number(e.target.value) } : w) })} />
          </label>
        </div>)}
      </details>
    </fieldset>)}
    {!segments.length && <p className={pub.note}>Konuşma bulunamadı.</p>}
  </section>;
}
