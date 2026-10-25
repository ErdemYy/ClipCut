"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { api, downloadUrl, formatTime, mediaUrl, type ClipAnalysis, type ClipCandidate, type ClipPreviewResult, type FillMode, type Job, type JobMap, type Project, type RenderOptions, type Waveform } from "@/lib/api";
import { clampClipRange, clipRangeError, snapClipEdge, type ClipRangeAction, type ClipRange } from "@/lib/clip-trim";
import { clipDraftContext, clipDraftStorageKey, defaultClipDraft, readClipDraft, serializeClipDraft } from "@/lib/clip-draft";
import { canRedoClipRanges, canUndoClipRanges, clipRangeHistoryReducer, emptyClipRangeHistory, type ClipRanges } from "@/lib/clip-range-history";
import ClipRangeStrip from "./ClipRangeStrip";
import { JobProgress } from "./SubtitlePanel";
import { PublishingResults, RenderSettings } from "./PublishingControls";
import styles from "./editor-parts.module.css";
import pub from "./publishing.module.css";

type PreviewSelection = { start: number; end: number };
type RangeField = keyof ClipRange;

const FILL_LABELS: Record<FillMode, string> = {
  blur: "bulanık arka plan",
  fit: "siyah kenar",
  crop: "merkez kırpma",
};

export default function ClipperPanel({ project, jobs, track, notify }: {
  project: Project; jobs: JobMap; track: (job: Job, onDone?: (j: Job) => void) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [minimum, setMinimum] = useState(30);
  const [maximum, setMaximum] = useState(60);
  const [count, setCount] = useState(5);
  const [selected, setSelected] = useState<number[]>([]);
  const [rangeHistory, dispatchRanges] = useReducer(clipRangeHistoryReducer, emptyClipRangeHistory);
  const ranges = rangeHistory.present;
  const [rangeDragging, setRangeDragging] = useState(false);
  const [snap, setSnap] = useState(true);
  const [preview, setPreview] = useState<PreviewSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [waveform, setWaveform] = useState<{ key: string; data?: Waveform; error?: string } | null>(null);
  const [waveformRetry, setWaveformRetry] = useState(0);
  const waveformHelpId = useId();
  const [options, setOptions] = useState<RenderOptions>({ resolution: "1080p", quality: "standard" });
  const [fill, setFill] = useState<FillMode>("blur");
  const previewVideo = useRef<HTMLVideoElement>(null);
  const backdropVideo = useRef<HTMLVideoElement>(null);
  const initializedAnalysis = useRef<string | null>(null);
  const [hydratedDraft, setHydratedDraft] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const analysis = jobs.clip_analyze;
  const result = analysis?.status === "done" && analysis.project_id === project.id
    ? analysis.result as unknown as ClipAnalysis : null;
  const draftContext = analysis && result ? clipDraftContext(project.id, project.source_url,
    project.duration, project.has_audio, analysis.id, result.clips) : null;
  const clipPreviewJob = jobs.clip_preview;
  const clipPreview = clipPreviewJob?.status === "done" && clipPreviewJob.result
    ? clipPreviewJob.result as unknown as ClipPreviewResult : null;
  const shownClipPreview = clipPreview && analysis && clipPreview.analysis_id === analysis.id ? clipPreview : null;
  const boundaries = result?.sentence_boundaries;
  const canSnap = !!boundaries && (boundaries.starts.length > 0 || boundaries.ends.length > 0);
  const smart = result ? (result.transcript_used ?? result.clips.some((clip) => clip.transcript_used)) : false;
  const clipPreviewRunning = clipPreviewJob?.status === "running" || clipPreviewJob?.status === "queued";
  const active = [analysis, jobs.clip_render, clipPreviewJob].find((j) => j?.status === "running" || j?.status === "queued");
  const disabled = pending || !!active || project.status !== "ready" || (!!draftContext && hydratedDraft !== draftContext);
  const sourceReady = project.has_audio && project.duration >= minimum;
  const fillLabel = FILL_LABELS[fill];
  const hasCandidates = !!result && result.clips.length > 0;
  const waveformKey = JSON.stringify([project.id, project.source_url, project.duration, project.has_audio, waveformRetry]);
  const waveformLoaded = waveform?.key === waveformKey ? waveform : null;
  const peaks = waveformLoaded?.data?.peaks;
  const waveformError = waveformLoaded?.error;
  const waveformLoading = hasCandidates && project.has_audio && !waveformLoaded;
  const setRanges = (update: ClipRanges | ((current: ClipRanges) => ClipRanges)) => {
    if (draftContext) dispatchRanges({ type: "preview", context: draftContext, ranges: update, duration: project.duration });
  };
  const commitRanges = (update: ClipRanges | ((current: ClipRanges) => ClipRanges)) => {
    if (draftContext) dispatchRanges({ type: "commit", context: draftContext, ranges: update, duration: project.duration });
  };

  const rangeFor = (clip: ClipCandidate): ClipRange =>
    ranges[clip.id] ?? { start: clip.start, end: clip.end };
  const selectedClips = result
    ? selected.map((id) => result.clips.find((clip) => clip.id === id)).filter((clip): clip is ClipCandidate => !!clip)
    : [];
  const invalidSelected = selectedClips.filter((clip) => clipRangeError(rangeFor(clip), project.duration));
  const previewResultClip = shownClipPreview && result
    ? result.clips.find((clip) => clip.id === shownClipPreview.clip_id) : undefined;
  const previewCurrentRange = shownClipPreview
    ? (previewResultClip ? rangeFor(previewResultClip) : { start: shownClipPreview.clip_start, end: shownClipPreview.clip_end })
    : null;
  const clipPreviewStale = !!shownClipPreview && (
    !previewResultClip || !previewCurrentRange
    || previewCurrentRange.start !== shownClipPreview.clip_start
    || previewCurrentRange.end !== shownClipPreview.clip_end
    || fill !== shownClipPreview.fill
    || options.resolution !== shownClipPreview.resolution
    || options.quality !== shownClipPreview.quality
    || shownClipPreview.render_revision !== project.render_revision
  );

  // These effects synchronize React drafts with synchronous browser storage.
  // Context-gated hydration happens once; status updates are not dependencies
  // of either effect and cannot cause a persistence/render loop.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!draftContext || !result || initializedAnalysis.current === draftContext) return;
    initializedAnalysis.current = draftContext;
    let draft = defaultClipDraft(result.clips);
    try {
      const restored = readClipDraft(localStorage.getItem(clipDraftStorageKey(project.id)), draftContext,
        result.clips, project.duration);
      if (restored) draft = restored;
      setDraftNotice(restored ? "Yerel klip taslağı geri yüklendi." : "Taslak bu tarayıcıda otomatik saklanır.");
    } catch { setDraftNotice("Tarayıcı depolamasına erişilemiyor; taslak yalnızca bu oturumda kalır."); }
    dispatchRanges({ type: "reset", context: draftContext, ranges: draft.ranges });
    setRangeDragging(false);
    setSelected(draft.selected);
    setOptions(draft.options);
    setFill(draft.fill);
    setSnap(draft.snap);
    setPreview(null);
    setHydratedDraft(draftContext);
  }, [draftContext, result, project.id, project.duration]);

  useEffect(() => {
    // The hydration render must never overwrite stored data with empty defaults.
    if (!draftContext || hydratedDraft !== draftContext || !result) return;
    const raw = serializeClipDraft({ ranges, selected, options, fill, snap }, draftContext, result.clips, project.duration);
    if (!raw) {
      setDraftNotice("Geçersiz aralık saklanmadı; son geçerli taslak korunuyor.");
      return;
    }
    try {
      localStorage.setItem(clipDraftStorageKey(project.id), raw);
      setDraftNotice("Taslak bu tarayıcıda saklandı; kaynak ve ana edit değişmedi.");
    } catch { setDraftNotice("Taslak saklanamadı (depolama kapalı veya dolu); değişiklikler yalnızca bu oturumda kalır."); }
  }, [draftContext, hydratedDraft, result, project.id, project.duration, ranges, selected, options, fill, snap]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const resetDraft = () => {
    if (disabled || rangeDragging || !result || !draftContext) return;
    const draft = defaultClipDraft(result.clips);
    dispatchRanges({ type: "reset", context: draftContext, ranges: draft.ranges });
    setSelected(draft.selected); setOptions(draft.options);
    setFill(draft.fill); setSnap(draft.snap); setPreview(null);
  };

  useEffect(() => {
    if (!hasCandidates || project.status !== "ready" || !project.has_audio) return;
    const controller = new AbortController();
    api.waveform(project.id, controller.signal).then((data) => {
      if (!controller.signal.aborted) setWaveform({ key: waveformKey, data });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setWaveform({ key: waveformKey, error: error.message });
    });
    return () => controller.abort();
  }, [hasCandidates, project.id, project.status, project.has_audio, waveformKey]);

  useEffect(() => {
    const foreground = previewVideo.current;
    const background = backdropVideo.current;
    if (!preview || !foreground) return;
    const seek = () => {
      foreground.currentTime = preview.start;
      if (background && background.readyState >= 1) background.currentTime = preview.start;
      foreground.play().catch(() => {});
    };
    if (foreground.readyState >= 1) seek();
    else foreground.addEventListener("loadedmetadata", seek, { once: true });
    return () => foreground.removeEventListener("loadedmetadata", seek);
  }, [preview]);

  const alignBackdrop = (force = false) => {
    const foreground = previewVideo.current;
    const background = backdropVideo.current;
    if (!foreground || !background || background.readyState < 1) return;
    if (force || Math.abs(background.currentTime - foreground.currentTime) > 0.15)
      background.currentTime = foreground.currentTime;
  };
  const playBackdrop = () => backdropVideo.current?.play().catch(() => {});
  const pauseBackdrop = () => backdropVideo.current?.pause();

  const updateRange = (clip: ClipCandidate, field: RangeField, value: number) => {
    setRanges((current) => {
      const base = current[clip.id] ?? { start: clip.start, end: clip.end };
      return { ...current, [clip.id]: { ...base, [field]: value } };
    });
  };
  const finalizeRange = (clip: ClipCandidate, field: RangeField) => {
    commitRanges((current) => {
      const base = current[clip.id] ?? { start: clip.start, end: clip.end };
      const clamped = clampClipRange(base, project.duration);
      const edges = field === "start" ? boundaries?.starts : boundaries?.ends;
      const value = snap && edges
        ? snapClipEdge(field, clamped[field], clamped, edges, project.duration)
        : clamped[field];
      return { ...current, [clip.id]: { ...clamped, [field]: value } };
    });
  };
  const setClipRange = (clip: ClipCandidate, next: ClipRange) => {
    setRanges((current) => ({ ...current, [clip.id]: next }));
  };
  const commitStripRange = (clip: ClipCandidate, field: ClipRangeAction, next: ClipRange) => {
    // Whole-range moves preserve duration; snapping a single edge would resize it.
    if (field === "move") {
      commitRanges((current) => ({ ...current, [clip.id]: next }));
      return;
    }
    const clamped = clampClipRange(next, project.duration);
    const edges = field === "start" ? boundaries?.starts : boundaries?.ends;
    const value = snap && edges
      ? snapClipEdge(field, clamped[field], clamped, edges, project.duration)
      : clamped[field];
    commitRanges((current) => ({ ...current, [clip.id]: { ...clamped, [field]: value } }));
  };
  const resetRange = (clip: ClipCandidate) => {
    commitRanges((current) => ({ ...current, [clip.id]: { start: clip.start, end: clip.end } }));
  };
  const previewClip = (clip: ClipCandidate) => {
    const range = rangeFor(clip);
    setPreview({ start: range.start, end: range.end });
  };

  const previewActual = async (clip: ClipCandidate) => {
    const range = rangeFor(clip);
    if (!analysis || clipRangeError(range, project.duration)) return;
    setPreview({ start: range.start, end: range.end });
    setPending(true);
    try {
      const next = await api.previewClip(project.id, {
        ...options, analysis_id: analysis.id, clip_id: clip.id,
        clip_range: { id: clip.id, start: range.start, end: range.end },
        aspect_ratio: "9:16", fill, duration: 5,
      });
      await track(next, () => notify("Gerçek 5 sn klip önizlemesi hazır; tam klip ve kaynak değişmedi."));
    } catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };

  const analyze = async () => {
    setPending(true); setSelected([]); setPreview(null);
    try { await track(await api.analyzeClips(project.id, { min_duration: minimum, max_duration: maximum, max_clips: count }), () => notify("Klip analizi tamamlandı.")); }
    catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };
  const render = async () => {
    if (!analysis || !result) return;
    if (invalidSelected.length > 0) {
      notify("Seçili kliplerde geçersiz aralık var; başlangıç ve bitişi düzeltin.", true);
      return;
    }
    setPending(true);
    try {
      await track(await api.renderClips(project.id, {
        ...options, analysis_id: analysis.id, clip_ids: selected, aspect_ratio: "9:16", fill,
        clip_ranges: selectedClips.map((clip) => ({ id: clip.id, ...rangeFor(clip) })),
      }), () => notify("Bağımsız klipler hazır."));
    } catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };

  return <div className={styles.section}>
    <header className={pub.intro}><h3>Uzun videodan kısa klipler</h3>
      <p>Kaynak sesteki duraklama ve konuşma yoğunluğuna göre 30–60 saniyelik adaylar bulunur. Gerçek kaynak transkripti varsa tam cümle sınırları, soru/merak kancası, konuşma temposu ve tekrar eden konu terimleri de yerel olarak puanlanır. Dalga formundaki tutamaçları sürükleyin veya sayı alanlarını kullanın; cümle sınırlarına yapıştırın ve 9:16 çıktı kadrajını önizleyin. Ücretli AI çağrısı yapmaz; viral başarı veya anlamsal önem garantisi değildir.</p>
    </header>
    <fieldset className={pub.settings} disabled={disabled}>
      <legend>Analiz aralığı</legend>
      <label>En kısa klip (sn)<input className="input" type="number" min="30" max={maximum} value={minimum} onChange={(e) => setMinimum(Number(e.target.value))} /></label>
      <label>En uzun klip (sn)<input className="input" type="number" min={minimum} max="60" value={maximum} onChange={(e) => setMaximum(Number(e.target.value))} /></label>
      <label>En fazla klip<select className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>
        {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n} klip</option>)}
      </select></label>
    </fieldset>
    {!sourceReady && <p className={pub.note}>Analiz için kaynak videoda ses ve en az {minimum} saniye süre gerekir.</p>}
    <button id="clips-analyze" className="btn btn-primary" disabled={disabled || !sourceReady || minimum < 30 || maximum > 60 || minimum > maximum} onClick={analyze}>Klip adaylarını bul</button>
    {active && <div role="status" aria-live="polite"><JobProgress job={active} /></div>}
    {analysis?.status === "failed" && <p role="alert" className={pub.error}>{analysis.error}</p>}
    {result && <section className={styles.section} aria-label="Klip adayları">
      <p className={pub.note}>{result.notice}</p>
      {result.clips.length === 0 ? <p role="status">{result.empty_reason}</p> : <>
        <h4>{result.clips.length} bağımsız aday{smart ? " · transkript destekli akıllı skor" : ""}</h4>
        <div className={pub.actions}>
          <button className="btn btn-sm" disabled={disabled} onClick={() => setSelected(result.clips.map((c) => c.id))}>Tümünü seç</button>
          <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`} disabled={disabled || rangeDragging} onClick={resetDraft}>Taslağı sıfırla</button>
          <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`}
            disabled={disabled || rangeDragging || !canUndoClipRanges(rangeHistory)} onClick={() => {
              if (draftContext) dispatchRanges({ type: "undo", context: draftContext });
              setPreview(null);
            }}>Aralık geri al</button>
          <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`}
            disabled={disabled || rangeDragging || !canRedoClipRanges(rangeHistory)} onClick={() => {
              if (draftContext) dispatchRanges({ type: "redo", context: draftContext });
              setPreview(null);
            }}>Aralık ileri al</button>
          <label className={pub.snapToggle} title="2 saniye yakınındaki cümle başlangıç/bitişlerine yapıştırır">
            <input type="checkbox" checked={snap} disabled={disabled || !canSnap} onChange={(e) => setSnap(e.target.checked)} />
            Yakın cümle sınırlarına yapıştır
          </label>
        </div>
        <p className={pub.note} role="status">{draftNotice} Seçimler, geçerli aralıklar, yapıştırma ve çıktı ayarları yalnızca bu tarayıcıda saklanır; kaynak veya analiz değişince eski taslak kullanılmaz. Sıfırlama aday aralıklarını ve varsayılan ayarları geri getirir.</p>
        <p className={pub.note}>Aralık geri al / ileri al yalnızca klip zamanlarını değiştirir; seçim, yapıştırma ve çıktı ayarlarını etkilemez. Bir sürükleme tek adımdır; sayı girişi alanından çıkınca tamamlanır. Geçersiz veya tamamlanmamış girişte geri al önce son tamamlanan aralığa döner. Son 30 adım bu panel oturumunda tutulur; sayfa/panel yeniden açılınca, kaynak/analiz değişince veya Taslağı sıfırla ile geçmiş temizlenir. Son aralıklar yine otomatik saklanır; ana video edit geçmişi değişmez.</p>
        {!canSnap && <p className={pub.note}>Kaynak transkripti veya cümle zamanı yok; yapıştırma kapalı. Başlangıç/bitiş yine elle ayarlanabilir.</p>}
        <p id={waveformHelpId} className={pub.note}>Başlangıç/bitiş tutamaçları süreyi ayarlar; aralığın ortasını sürüklemek süreyi koruyarak taşır. Sürükleme görünür dalga penceresiyle sınırlıdır. Odaklanan tutamaç veya aralıkta ok tuşları 0,1 sn, Shift ile 1 sn; Home/End kaynak sınırına taşır. Escape veya dokunma iptali sürüklemeyi geri alır. Taşırken cümleye yapıştırma uygulanmaz; 1 sn taşı düğmeleri sürükleme alternatifidir. 30–60 sn ve kaynak sınırları korunur. Sayı alanları hassas giriş içindir. Dalga, kaynak sesin mono tepe genliğidir; editin kesim/hız veya müzik karışımı değildir. Çizim görünür pencereye göre ölçeklenir; ses düzeyi ölçümü değildir.</p>
        {waveformLoading && <p className={pub.note} role="status">Kaynak ses dalgası hazırlanıyor; tutamaçlar şimdiden kullanılabilir.</p>}
        {waveformError && <div className={pub.actions} role="alert">
          <span className={pub.note}>Ses dalgası yüklenemedi; tutamaçlar düz çizgi üzerinde çalışır. {waveformError}</span>
          <button type="button" className="btn btn-sm" onClick={() => setWaveformRetry((value) => value + 1)}>Yeniden dene</button>
        </div>}
        {result.clips.map((clip, index) => {
          const range = rangeFor(clip);
          const error = clipRangeError(range, project.duration);
          return <article className={pub.candidate} key={clip.id}>
            <label className={pub.candidateLabel}>
              <input type="checkbox" checked={selected.includes(clip.id)} disabled={disabled} onChange={(e) => setSelected((current) => e.target.checked ? [...current, clip.id] : current.filter((i) => i !== clip.id))} />
              {formatTime(range.start)} – {formatTime(range.end)} · {(range.end - range.start).toFixed(1)} sn
            </label>
            <div className={pub.trimRow}>
              <label>Başlangıç (sn)<input className="input" type="number" min="0" max={project.duration} step="0.1" value={range.start}
                disabled={disabled} onChange={(e) => updateRange(clip, "start", Number(e.target.value))}
                onBlur={() => finalizeRange(clip, "start")}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
              <label>Bitiş (sn)<input className="input" type="number" min="0" max={project.duration} step="0.1" value={range.end}
                disabled={disabled} onChange={(e) => updateRange(clip, "end", Number(e.target.value))}
                onBlur={() => finalizeRange(clip, "end")}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
              <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => resetRange(clip)}>Akıllı aralık</button>
            </div>
            <ClipRangeStrip label={`${index + 1}. aday`} duration={project.duration} range={range}
              peaks={peaks} disabled={disabled || !!error} describedBy={waveformHelpId}
              onGestureChange={setRangeDragging}
              onChange={(next) => setClipRange(clip, next)}
              onCommit={(next, edge) => commitStripRange(clip, edge, next)} />
            {error && <small className={pub.error} role="alert">{error}</small>}
            <small>{clip.transcript_used ? "Akıllı skor" : "Konuşma skoru"} {clip.score}/100 · %{Math.round(clip.speech_ratio * 100)} konuşma{clip.words_per_minute !== null ? ` · ${clip.words_per_minute} kelime/dk` : " · tempo: ses aktivitesi tahmini"}</small>
            {clip.transcript_used && <div className={pub.badges}>
              {clip.sentence_aligned && <span className={pub.badge}>Cümle sınırı</span>}
              {typeof clip.hook_score === "number" && clip.hook_score >= 0.7 && <span className={pub.badge}>Açılış kancası %{Math.round(clip.hook_score * 100)}</span>}
              {typeof clip.topic_score === "number" && clip.topic_score >= 0.5 && <span className={pub.badge}>Konu yoğunluğu %{Math.round(clip.topic_score * 100)}</span>}
            </div>}
            <small>{clip.reason}</small>
            {clip.excerpt && <p>{clip.excerpt}</p>}
            <div className={pub.actions}>
              <button type="button" className="btn btn-sm" onClick={() => previewClip(clip)}>Bu aralığı 9:16 önizle</button>
              <button type="button" className="btn btn-sm" disabled={disabled || !!error}
                title="Seçili aralığın ilk 5 saniyesini altyazı, renk ve reframe ile FFmpeg'de render eder."
                onClick={() => previewActual(clip)}>
                {clipPreviewJob?.status === "running" || clipPreviewJob?.status === "queued"
                  ? "Gerçek önizleme hazırlanıyor…" : "Gerçek 5 sn önizle"}
              </button>
            </div>
          </article>;
        })}
        {preview && <section className={pub.previewSection} aria-label="9:16 klip önizlemesi">
          <div className={pub.previewFrame}>
            <video ref={backdropVideo} className={`${pub.previewBackdrop} ${fill === "blur" ? "" : pub.previewBackdropHidden}`}
              src={mediaUrl(project.source_url)} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1}
              onLoadedMetadata={(e) => { const foreground = previewVideo.current; if (foreground) e.currentTarget.currentTime = foreground.currentTime; }} />
            <video ref={previewVideo} className={`${pub.previewVideo} ${fill === "crop" ? pub.previewCover : pub.previewContain}`}
              src={mediaUrl(project.source_url)} controls playsInline preload="metadata"
              aria-label="Seçilen klip aralığının 9:16 önizlemesi"
              onPlay={(e) => {
                if (e.currentTarget.currentTime < preview.start || e.currentTarget.currentTime >= preview.end)
                  e.currentTarget.currentTime = preview.start;
                alignBackdrop(true);
                playBackdrop();
              }}
              onPause={pauseBackdrop}
              onEnded={pauseBackdrop}
              onSeeked={(e) => {
                if (e.currentTarget.currentTime < preview.start) e.currentTarget.currentTime = preview.start;
                else if (e.currentTarget.currentTime > preview.end) e.currentTarget.currentTime = preview.end;
                alignBackdrop(true);
              }}
              onTimeUpdate={(e) => {
                if (e.currentTarget.currentTime >= preview.end) {
                  e.currentTarget.pause();
                  pauseBackdrop();
                } else alignBackdrop();
              }} />
          </div>
          <p className={pub.note}>9:16 · {fillLabel} · {formatTime(preview.start)} – {formatTime(preview.end)}. Canlı önizleme çıktının kadraj ve dolgu görünümünü gösterir; kesin sonuç FFmpeg render çıktısıdır.</p>
        </section>}
        {(shownClipPreview || clipPreviewRunning || clipPreviewJob?.status === "failed") &&
          <section className={pub.actualPreview} aria-label="Gerçek FFmpeg klip önizlemesi">
            <h4>Gerçek FFmpeg önizlemesi</h4>
            {clipPreviewRunning && clipPreviewJob && <div role="status" aria-live="polite"><JobProgress job={clipPreviewJob} /></div>}
            {clipPreviewJob?.status === "failed" &&
              <p className={pub.error} role="alert">{clipPreviewJob.error || "Klip önizlemesi oluşturulamadı; yeniden deneyin."}</p>}
            {shownClipPreview && <>
              <p className={pub.note}>Tam klip aralığı {formatTime(shownClipPreview.clip_start)} – {formatTime(shownClipPreview.clip_end)}. Bu dosya, tam çıktının ilk {shownClipPreview.duration.toFixed(1)} saniyesidir; altyazı, renk ve seçili dolgu dahildir. Tam klip ve kaynak değişmez.</p>
              {clipPreviewStale && <p className={pub.note} role="status">Aralık veya render ayarları değişti. Güncel gerçek önizleme için yeniden oluşturun.</p>}
              <video key={shownClipPreview.output} src={mediaUrl(shownClipPreview.output)} controls playsInline preload="metadata"
                aria-label="Seçilen klip aralığının gerçek FFmpeg önizlemesi" />
              <p className={pub.note}>{shownClipPreview.width} × {shownClipPreview.height} · {shownClipPreview.duration.toFixed(1)} sn · {FILL_LABELS[shownClipPreview.fill]} · {shownClipPreview.resolution} / {shownClipPreview.quality}</p>
              <a className="btn btn-sm" href={downloadUrl(shownClipPreview.output)} download>Bu önizlemeyi indir</a>
            </>}
          </section>}
        <RenderSettings value={options} onChange={setOptions} fill={fill} onFill={setFill} disabled={disabled} />
        <p className={pub.note}>Elle ayarlanan klipler 30–60 saniye aralığında kalmalı ve kaynak video sınırlarını aşmamalıdır. 9:16 bağımsız MP4 dosyaları hazırlanır. Kaynak ses ve varsa altyazı/renk stili korunur; editteki hız, kesimler, seslendirme ve zamanlı katmanlar bu kliplere uygulanmaz.</p>
        <button id="clips-render" className="btn btn-primary" disabled={disabled || selected.length === 0 || invalidSelected.length > 0} onClick={render}>
          {selected.length} klibi hazırla
        </button>
      </>}
    </section>}
    <PublishingResults job={jobs.clip_render} />
  </div>;
}
