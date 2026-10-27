"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { api, downloadUrl, formatTime, mediaUrl, type ClipAnalysis, type ClipCandidate, type ClipPreviewResult, type ExportFormat, type FillMode, type Job, type JobMap, type Project, type PublishResult, type RenderOptions, type Waveform } from "@/lib/api";
import { clampClipRange, clipRangeError, snapClipEdge, type ClipRangeAction, type ClipRange } from "@/lib/clip-trim";
import { CLIP_FORMATS, clipDraftContext, clipDraftStorageKey, clipPreviewFormat, defaultClipDraft, readClipDraft, serializeClipDraft, toggleClipFormat } from "@/lib/clip-draft";
import { clipExportFreshness } from "@/lib/clip-export";
import { editablePublishedClipIds } from "@/lib/publishing-results";
import { canRedoClipRanges, canUndoClipRanges, clipRangeHistoryReducer, emptyClipRangeHistory, type ClipRanges } from "@/lib/clip-range-history";
import { clipPreviewIsStale, clipPreviewSelection, clipPreviewWindow, type ClipPreviewSelection } from "@/lib/clip-preview";
import { clipCoverError, clipCoverMax } from "@/lib/clip-cover";
import ClipRangeStrip from "./ClipRangeStrip";
import { JobProgress } from "./SubtitlePanel";
import { PublishingResults, RenderSettings } from "./PublishingControls";
import styles from "./editor-parts.module.css";
import pub from "./publishing.module.css";

type PreviewSelection = { start: number; end: number; still?: boolean };
type RangeField = keyof ClipRange;

const FILL_LABELS: Record<FillMode, string> = {
  blur: "bulanık arka plan",
  fit: "siyah kenar",
  crop: "merkez kırpma",
};

const FORMAT_LABELS: Record<ExportFormat, string> = {
  "9:16": "9:16 · TikTok / Reels / Shorts",
  "1:1": "1:1 · Instagram kare",
  "4:5": "4:5 · Instagram portre",
  "16:9": "16:9 · YouTube / yatay",
};

export default function ClipperPanel({ project, jobs, track, notify }: {
  project: Project; jobs: JobMap; track: (job: Job, onDone?: (j: Job) => void) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [minimum, setMinimum] = useState(30);
  const [maximum, setMaximum] = useState(60);
  const [count, setCount] = useState(5);
  const [selected, setSelected] = useState<number[]>([]);
  const [covers, setCovers] = useState<Record<number, number>>({});
  const [rangeHistory, dispatchRanges] = useReducer(clipRangeHistoryReducer, emptyClipRangeHistory);
  const ranges = rangeHistory.present;
  const [rangeDragging, setRangeDragging] = useState(false);
  const [snap, setSnap] = useState(true);
  const [preview, setPreview] = useState<PreviewSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [waveform, setWaveform] = useState<{ key: string; data?: Waveform; error?: string } | null>(null);
  const [waveformRetry, setWaveformRetry] = useState(0);
  const waveformHelpId = useId();
  const clipStartFields = useRef<Record<number, HTMLInputElement | null>>({});
  const [options, setOptions] = useState<RenderOptions>({ resolution: "1080p", quality: "standard" });
  const [fill, setFill] = useState<FillMode>("blur");
  const [aspects, setAspects] = useState<ExportFormat[]>(["9:16"]);
  const [previewAspect, setPreviewAspect] = useState<ExportFormat>("9:16");
  const aspect = clipPreviewFormat(aspects, previewAspect);
  const previewFormatHelpId = useId();
  const [previewWindows, setPreviewWindows] = useState<{ context: string | null; values: Record<number, ClipPreviewSelection> }>({ context: null, values: {} });
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
  const clipRenderJob = jobs.clip_render;
  const clipRenderResult = clipRenderJob?.status === "done" && clipRenderJob.project_id === project.id && clipRenderJob.result
    ? clipRenderJob.result as unknown as PublishResult : null;
  const clipPreview = clipPreviewJob?.status === "done" && clipPreviewJob.result
    ? clipPreviewJob.result as unknown as ClipPreviewResult : null;
  const shownClipPreview = clipPreview && analysis && clipPreview.analysis_id === analysis.id ? clipPreview : null;
  const previewWindowFor = (clipId: number): ClipPreviewSelection =>
    (previewWindows.context === draftContext ? previewWindows.values[clipId] : undefined)
    ?? clipPreviewSelection(shownClipPreview?.clip_id === clipId && shownClipPreview.render_revision === project.render_revision
      ? shownClipPreview : null);
  const updatePreviewWindow = (clipId: number, patch: Partial<ClipPreviewSelection>) => {
    setPreviewWindows((current) => {
      const values = current.context === draftContext ? current.values : {};
      return { context: draftContext, values: { ...values,
        [clipId]: { ...(values[clipId] ?? previewWindowFor(clipId)), ...patch } } };
    });
  };
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
  const invalidCovers = selectedClips.filter((clip) => clipCoverError(covers[clip.id] ?? 0, rangeFor(clip)));
  const clipRenderFreshness = clipRenderResult
    ? (!result || !analysis ? "unknown" : clipExportFreshness(clipRenderResult, {
      analysisId: analysis.id,
      clips: selectedClips.map((clip) => ({ id: clip.id, ...rangeFor(clip), cover: covers[clip.id] ?? 0 })),
      aspects, fill, options, renderRevision: project.render_revision,
    })) : null;
  const previewResultClip = shownClipPreview && result
    ? result.clips.find((clip) => clip.id === shownClipPreview.clip_id) : undefined;
  const clipPreviewStale = !!shownClipPreview && clipPreviewIsStale(shownClipPreview,
    previewResultClip ? rangeFor(previewResultClip) : undefined,
    previewWindowFor(shownClipPreview.clip_id), options, fill, aspect, project.render_revision);
  const editableClipIds = clipRenderResult && result && !disabled && !rangeDragging
    ? editablePublishedClipIds(clipRenderResult, analysis?.id, result.clips) : {};
  const clipEditors = Object.fromEntries(Object.entries(editableClipIds).map(([index, id]) => [index, () => {
    const field = clipStartFields.current[id];
    if (!field || field.disabled) return;
    field.focus();
    notify(`Klip ${index} düzenleme alanı açıldı; mevcut aralık korunuyor.`);
  }]));

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
    setCovers(draft.covers);
    setOptions(draft.options);
    setFill(draft.fill);
    setAspects(draft.aspects);
    setPreviewAspect(draft.previewAspect);
    setSnap(draft.snap);
    setPreview(null);
    setHydratedDraft(draftContext);
  }, [draftContext, result, project.id, project.duration]);

  useEffect(() => {
    // The hydration render must never overwrite stored data with empty defaults.
    if (!draftContext || hydratedDraft !== draftContext || !result) return;
    const raw = serializeClipDraft({ ranges, covers, selected, options, fill, aspects, previewAspect: aspect, snap }, draftContext, result.clips, project.duration);
    if (!raw) {
      setDraftNotice("Geçersiz aralık, kapak veya format seçimi saklanmadı; son geçerli taslak korunuyor.");
      return;
    }
    try {
      localStorage.setItem(clipDraftStorageKey(project.id), raw);
      setDraftNotice("Taslak bu tarayıcıda saklandı; kaynak ve ana edit değişmedi.");
    } catch { setDraftNotice("Taslak saklanamadı (depolama kapalı veya dolu); değişiklikler yalnızca bu oturumda kalır."); }
  }, [draftContext, hydratedDraft, result, project.id, project.duration, ranges, covers, selected, options, fill, aspects, aspect, snap]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const resetDraft = () => {
    if (disabled || rangeDragging || !result || !draftContext) return;
    const draft = defaultClipDraft(result.clips);
    dispatchRanges({ type: "reset", context: draftContext, ranges: draft.ranges });
    setSelected(draft.selected); setOptions(draft.options);
    setCovers(draft.covers);
    setFill(draft.fill); setAspects(draft.aspects); setSnap(draft.snap); setPreview(null);
    setPreviewAspect(draft.previewAspect);
    setPreviewWindows({ context: draftContext, values: Object.fromEntries(result.clips.map((clip) =>
      [clip.id, { start: 0, duration: 5 as const }])) });
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
      if (preview.still) {
        foreground.pause();
        background?.pause();
      } else foreground.play().catch(() => {});
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
  const previewCover = (clip: ClipCandidate) => {
    const range = rangeFor(clip);
    const at = covers[clip.id] ?? 0;
    if (clipCoverError(at, range) || clipRangeError(range, project.duration)) return;
    setPreview({ start: range.start + at, end: range.end, still: true });
  };

  const previewActual = async (clip: ClipCandidate) => {
    const range = rangeFor(clip);
    const selection = previewWindowFor(clip.id);
    const window = clipPreviewWindow(range, selection);
    if (!analysis || clipRangeError(range, project.duration) || !window.valid) return;
    updatePreviewWindow(clip.id, selection);
    setPreview({ start: range.start, end: range.end });
    setPending(true);
    try {
      const next = await api.previewClip(project.id, {
        ...options, analysis_id: analysis.id, clip_id: clip.id,
        clip_range: { id: clip.id, start: range.start, end: range.end },
        aspect_ratio: aspect, fill, start: selection.start, duration: selection.duration,
      });
      await track(next, () => notify("Seçilen bölümün gerçek klip önizlemesi hazır; tam klip ve kaynak değişmedi."));
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
    if (invalidSelected.length > 0 || invalidCovers.length > 0) {
      notify("Seçili kliplerde geçersiz aralık veya kapak zamanı var; alanları düzeltin.", true);
      return;
    }
    setPending(true);
    try {
      await track(await api.renderClips(project.id, {
        ...options, analysis_id: analysis.id, clip_ids: selected, aspect_ratio: aspects[0], aspect_ratios: aspects, fill,
        clip_ranges: selectedClips.map((clip) => ({ id: clip.id, ...rangeFor(clip) })),
        clip_covers: selectedClips.map((clip) => ({ id: clip.id, at: covers[clip.id] ?? 0 })),
      }), () => notify("Bağımsız klipler hazır."));
    } catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };

  return <div className={styles.section}>
    <header className={pub.intro}><h3>Uzun videodan kısa klipler</h3>
      <p>Kaynak sesteki duraklama ve konuşma yoğunluğuna göre 30–60 saniyelik adaylar bulunur. Gerçek kaynak transkripti varsa tam cümle sınırları, soru/merak kancası, konuşma temposu ve tekrar eden konu terimleri de yerel olarak puanlanır. Dalga formundaki tutamaçları sürükleyin veya sayı alanlarını kullanın; cümle sınırlarına yapıştırın ve önizleme formatında çıktı kadrajını kontrol edin. Ücretli AI çağrısı yapmaz; viral başarı veya anlamsal önem garantisi değildir.</p>
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
        <p className={pub.note} role="status">{draftNotice} Seçimler, geçerli aralıklar, kapak zamanları, çıktı formatları, yapıştırma ve render ayarları yalnızca bu tarayıcıda saklanır; kaynak veya analiz değişince eski taslak kullanılmaz. Sıfırlama aday aralıklarını, kapakları, formatları ve varsayılan ayarları geri getirir.</p>
        <p className={pub.note}>Aralık geri al / ileri al yalnızca klip zamanlarını değiştirir; seçim, kapak, formatlar, yapıştırma ve çıktı ayarlarını etkilemez. Bir sürükleme tek adımdır; sayı girişi alanından çıkınca tamamlanır. Geçersiz veya tamamlanmamış girişte geri al önce son tamamlanan aralığa döner. Son 30 adım bu panel oturumunda tutulur; sayfa/panel yeniden açılınca, kaynak/analiz değişince veya Taslağı sıfırla ile geçmiş temizlenir. Son aralıklar yine otomatik saklanır; ana video edit geçmişi değişmez.</p>
        {!canSnap && <p className={pub.note}>Kaynak transkripti veya cümle zamanı yok; yapıştırma kapalı. Başlangıç/bitiş yine elle ayarlanabilir.</p>}
        <p id={waveformHelpId} className={pub.note}>Başlangıç/bitiş tutamaçları süreyi ayarlar; aralığın ortasını sürüklemek süreyi koruyarak taşır. Sürükleme görünür dalga penceresiyle sınırlıdır. Odaklanan tutamaç veya aralıkta ok tuşları 0,1 sn, Shift ile 1 sn; Home/End kaynak sınırına taşır. Escape veya dokunma iptali sürüklemeyi geri alır. Taşırken cümleye yapıştırma uygulanmaz; 1 sn taşı düğmeleri sürükleme alternatifidir. 30–60 sn ve kaynak sınırları korunur. Sayı alanları hassas giriş içindir. Dalga, kaynak sesin mono tepe genliğidir; editin kesim/hız veya müzik karışımı değildir. Çizim görünür pencereye göre ölçeklenir; ses düzeyi ölçümü değildir.</p>
        <p className={pub.note}>Gerçek önizleme başlangıcı her klibin kendi sıfırına göredir. Bölümü ve 5/10 sn süreyi seçip render düğmesine basın; işlem otomatik başlamaz, ücretli AI çağrısı yapmaz. Geç bölümler önceki karelerin işlenmesini gerektirebilir. Bölüm seçimleri taslağa kaydedilmez; yeniden açılışta son önizlemenin bölümü geri gelir.</p>
        {waveformLoading && <p className={pub.note} role="status">Kaynak ses dalgası hazırlanıyor; tutamaçlar şimdiden kullanılabilir.</p>}
        {waveformError && <div className={pub.actions} role="alert">
          <span className={pub.note}>Ses dalgası yüklenemedi; tutamaçlar düz çizgi üzerinde çalışır. {waveformError}</span>
          <button type="button" className="btn btn-sm" onClick={() => setWaveformRetry((value) => value + 1)}>Yeniden dene</button>
        </div>}
        <fieldset className={pub.settings} disabled={disabled}>
          <legend>Klip önizlemesi</legend>
          <label>Önizleme formatı<select className={`select ${pub.trimShiftButton}`} value={aspect}
            aria-describedby={previewFormatHelpId}
            onChange={(e) => setPreviewAspect(e.target.value as ExportFormat)}>
            {aspects.map((format) => <option key={format} value={format}>{FORMAT_LABELS[format]}</option>)}
          </select></label>
          <p id={previewFormatHelpId} className={pub.note}>Seçili çıktı formatları arasında canlı ve gerçek önizleme kadrajını değiştirir. Çıktı listesi, sırası ve hazır dosyaların güncelliği değişmez. Gerçek önizlemeyi yenilemek için yeniden önizleme hazırlayın; işlem otomatik başlamaz.</p>
        </fieldset>
        {result.clips.map((clip, index) => {
          const range = rangeFor(clip);
          const error = clipRangeError(range, project.duration);
          const previewSelection = previewWindowFor(clip.id);
          const previewPart = clipPreviewWindow(range, previewSelection);
          const coverAt = covers[clip.id] ?? 0;
          const coverError = clipCoverError(coverAt, range);
          return <article className={pub.candidate} key={clip.id}>
            <label className={pub.candidateLabel}>
              <input type="checkbox" checked={selected.includes(clip.id)} disabled={disabled} onChange={(e) => setSelected((current) => e.target.checked ? [...current, clip.id] : current.filter((i) => i !== clip.id))} />
              {formatTime(range.start)} – {formatTime(range.end)} · {(range.end - range.start).toFixed(1)} sn
            </label>
            <div className={pub.trimRow}>
              <label>Başlangıç (sn)<input className="input" type="number" min="0" max={project.duration} step="0.1" value={range.start}
                ref={(field) => { clipStartFields.current[clip.id] = field; }} aria-label={`${index + 1}. aday başlangıç (sn)`}
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
            <fieldset className={pub.settings} disabled={disabled || !!error}>
              <legend>{index + 1}. klip · JPG kapak karesi</legend>
              <label>Kapak zamanı (klip içinde sn)<input className={`input ${pub.trimShiftButton}`} type="number"
                min="0" max={clipCoverMax(range)} step="0.1" value={Number.isFinite(coverAt) ? coverAt : ""}
                onChange={(e) => setCovers((current) => ({ ...current, [clip.id]: e.target.valueAsNumber }))} /></label>
              <div className={pub.actions}>
                <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`}
                  onClick={() => setCovers((current) => ({ ...current, [clip.id]: 0 }))}>İlk kare</button>
                <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`}
                  onClick={() => setCovers((current) => ({ ...current, [clip.id]: Math.round((range.end - range.start) * 500) / 1000 }))}>Klip ortası</button>
                <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`} disabled={!!coverError}
                  onClick={() => previewCover(clip)}>Kaynak karesini göster</button>
              </div>
            </fieldset>
            {coverError && !error ? <p className={pub.error} role="alert">{coverError} En geç {clipCoverMax(range).toFixed(3)} sn seçin.</p>
              : !error && <p className={pub.note}>Kapak kaynakta {(range.start + coverAt).toFixed(1)} sn karesinden seçilir. Kaynak önizleme yaklaşık kadrajdır; kesin JPG klip render edilince, altyazı/renk/dolgu uygulanmış MP4&apos;ten çıkarılır ve ZIP&apos;e eklenir. Ana proje kapağı değişmez; kare hassasiyeti geçerlidir. Klip aralığını değiştirince kapak zamanını kontrol edin; çıktıdaki kapağı değiştirmek için klipleri yeniden hazırlayın.</p>}
            <fieldset className={pub.settings} disabled={disabled || !!error}>
              <legend>{index + 1}. klip · gerçek önizleme bölümü</legend>
              <label>Önizleme başlangıcı (klip içinde sn)<input className={`input ${pub.trimShiftButton}`} type="number"
                min="0" max={previewPart.maxStart} step="0.1"
                value={Number.isFinite(previewSelection.start) ? previewSelection.start : ""}
                onChange={(e) => updatePreviewWindow(clip.id, { start: e.target.valueAsNumber })} /></label>
              <label>Önizleme süresi<select className="select" value={previewSelection.duration}
                onChange={(e) => updatePreviewWindow(clip.id, { duration: Number(e.target.value) as 5 | 10 })}>
                <option value="5">5 saniye</option><option value="10">10 saniye</option>
              </select></label>
              <div className={pub.actions}>
                <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`}
                  onClick={() => updatePreviewWindow(clip.id, { start: 0 })}>Klip başı</button>
                <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`}
                  onClick={() => updatePreviewWindow(clip.id, { start: Math.max(0, Math.round((range.end - range.start - previewSelection.duration) * 1000) / 1000) })}>Son {previewSelection.duration} sn</button>
              </div>
            </fieldset>
            {!error && (previewPart.valid
              ? <p className={pub.note}>Klip içinde {previewSelection.start.toFixed(1)} – {(previewSelection.start + previewPart.duration).toFixed(1)} sn · kaynakta {previewPart.sourceStart.toFixed(1)} – {previewPart.sourceEnd.toFixed(1)} sn. Gerçekte {previewPart.duration.toFixed(1)} sn render edilir; klip sonunda kalan süre kullanılır.</p>
              : <p className={pub.error} role="alert">Önizleme başlangıcı 0 ile {previewPart.maxStart.toFixed(3)} sn arasında olmalı; klip sonunda en az 0,1 sn kalmalı.</p>)}
            <div className={pub.actions}>
              <button type="button" className="btn btn-sm" onClick={() => previewClip(clip)}>Bu aralığı {aspect} önizle</button>
              <button type="button" className="btn btn-sm" disabled={disabled || !!error || !previewPart.valid}
                title="Klip içinde seçilen bölümü altyazı, renk ve reframe ile FFmpeg'de render eder."
                onClick={() => previewActual(clip)}>
                {clipPreviewJob?.status === "running" || clipPreviewJob?.status === "queued"
                  ? "Gerçek önizleme hazırlanıyor…" : `Gerçek ${previewSelection.duration} sn önizle`}
              </button>
            </div>
          </article>;
        })}
        {preview && <section className={pub.previewSection} aria-label={`${aspect} klip önizlemesi`}>
          <div className={pub.previewFrame} style={{ aspectRatio: aspect.replace(":", " / ") }}>
            <video ref={backdropVideo} className={`${pub.previewBackdrop} ${fill === "blur" ? "" : pub.previewBackdropHidden}`}
              src={mediaUrl(project.source_url)} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1}
              onLoadedMetadata={(e) => { const foreground = previewVideo.current; if (foreground) e.currentTarget.currentTime = foreground.currentTime; }} />
            <video ref={previewVideo} className={`${pub.previewVideo} ${fill === "crop" ? pub.previewCover : pub.previewContain}`}
              src={mediaUrl(project.source_url)} controls playsInline preload="metadata"
              aria-label={`Seçilen klip aralığının ${aspect} önizlemesi`}
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
          <p className={pub.note}>{aspect} · {fillLabel} · {preview.still ? `Kapak için kaynak kare: ${preview.start.toFixed(1)} sn` : `${formatTime(preview.start)} – ${formatTime(preview.end)}`}. Canlı önizleme çıktının kadraj ve dolgu görünümünü yaklaşık gösterir. {preview.still ? "Altyazı/renk uygulanmış kesin kapak JPG klip render edilince oluşur." : "Kesin sonuç gerçek FFmpeg render çıktısıdır."}</p>
        </section>}
        {(shownClipPreview || clipPreviewRunning || clipPreviewJob?.status === "failed") &&
          <section className={pub.actualPreview} aria-label="Gerçek FFmpeg klip önizlemesi">
            <h4>Gerçek FFmpeg önizlemesi</h4>
            {clipPreviewRunning && clipPreviewJob && <div role="status" aria-live="polite"><JobProgress job={clipPreviewJob} /></div>}
            {clipPreviewJob?.status === "failed" &&
              <p className={pub.error} role="alert">{clipPreviewJob.error || "Klip önizlemesi oluşturulamadı; yeniden deneyin."}</p>}
            {shownClipPreview && <>
              <p className={pub.note}>Tam klip kaynakta {shownClipPreview.clip_start.toFixed(1)} – {shownClipPreview.clip_end.toFixed(1)} sn. Bu dosya {shownClipPreview.aspect_ratio} formatında, klip içinde {clipPreviewSelection(shownClipPreview).start.toFixed(1)} – {(clipPreviewSelection(shownClipPreview).start + shownClipPreview.duration).toFixed(1)} sn bölümüdür (kaynakta {shownClipPreview.start.toFixed(1)} – {shownClipPreview.end.toFixed(1)} sn). İstenen {clipPreviewSelection(shownClipPreview).duration} sn, gerçek {shownClipPreview.duration.toFixed(1)} sn; altyazı, renk ve seçili dolgu dahildir. Tam klip ve kaynak değişmez.</p>
              {clipPreviewStale && <p className={pub.note} role="status">Aralık, önizleme bölümü, format veya render ayarları değişti. Güncel gerçek önizleme için yeniden oluşturun.</p>}
              <video key={shownClipPreview.output} src={mediaUrl(shownClipPreview.output)} controls playsInline preload="metadata"
                aria-label="Seçilen klip aralığının gerçek FFmpeg önizlemesi" />
              <p className={pub.note}>{shownClipPreview.width} × {shownClipPreview.height} · {shownClipPreview.duration.toFixed(1)} sn · {FILL_LABELS[shownClipPreview.fill]} · {shownClipPreview.resolution} / {shownClipPreview.quality}</p>
              <a className="btn btn-sm" href={downloadUrl(shownClipPreview.output)} download>Bu önizlemeyi indir</a>
            </>}
          </section>}
        <fieldset className={pub.formats} disabled={disabled}>
          <legend>Kısa klip çıktı formatları</legend>
          {CLIP_FORMATS.map((format) => <label key={format}>
            <input type="checkbox" checked={aspects.includes(format)}
              disabled={disabled || (aspects.length === 1 && aspects.includes(format))}
              onChange={() => {
                const next = toggleClipFormat(aspects, format);
                setAspects(next);
                setPreviewAspect(clipPreviewFormat(next, aspect));
              }} />
            <span>{FORMAT_LABELS[format]}</span>
          </label>)}
        </fieldset>
        <p className={pub.note}>Birden fazla format seçilebilir; her seçili klip için her formatta ayrı MP4 ve JPG üretilir, ZIP tüm dosyaları içerir. Son format kaldırılamaz. Kadrajı üstteki Önizleme formatı alanından değiştirebilirsiniz; önizlenen formatı çıktı listesinden kaldırırsanız ilk kalan format kullanılır. Format sayısı arttıkça render süresi de artar. Kaynak medya ve ana projenin çıktı formatı değişmez.</p>
        <RenderSettings value={options} onChange={setOptions} fill={fill} onFill={setFill} disabled={disabled} />
        <p className={pub.note}>Elle ayarlanan klipler 30–60 saniye aralığında kalmalı ve kaynak video sınırlarını aşmamalıdır. Seçilen her formatta bağımsız MP4 dosyaları hazırlanır. Kaynak ses ve varsa altyazı/renk stili korunur; editteki hız, kesimler, seslendirme ve zamanlı katmanlar bu kliplere uygulanmaz.</p>
        <button id="clips-render" className="btn btn-primary" disabled={disabled || selected.length === 0 || invalidSelected.length > 0 || invalidCovers.length > 0} onClick={render}>
          {selected.length} klibi {aspects.length > 1 ? `${aspects.length} formatta ` : ""}hazırla
        </button>
      </>}
    </section>}
    <PublishingResults job={clipRenderJob}
      clipEditors={clipEditors}
      freshness={clipRenderFreshness === "stale" || clipRenderFreshness === "unknown" ? clipRenderFreshness : undefined} />
  </div>;
}
