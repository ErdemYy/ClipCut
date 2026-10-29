"use client";

import { useEffect, useState } from "react";
import { api, formatTime, type Job, type JobMap, type Project, type RenderOptions, type TranscriptEdit } from "@/lib/api";
import { toggleTranscriptRow, transcriptSelection } from "@/lib/transcript-edit";
import { PublishingResults, RenderSettings } from "./PublishingControls";
import { JobProgress } from "./SubtitlePanel";
import styles from "./editor-parts.module.css";
import pub from "./publishing.module.css";

type Props = {
  project: Project; setProject: (project: Project) => void; jobs: JobMap;
  track: (job: Job, onDone?: (job: Job) => void) => Promise<void>;
  notify: (text: string, error?: boolean) => void; seek: (time: number) => void;
};

export default function TranscriptPanel({ project, setProject, jobs, track, notify, seek }: Props) {
  const [loaded, setLoaded] = useState<{ key: string; data?: TranscriptEdit; error?: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<{ revision: string; ids: number[] } | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [options, setOptions] = useState<RenderOptions>({ resolution: "1080p", quality: "standard" });
  const [fill, setFill] = useState<"blur" | "fit" | "crop">("blur");
  const key = JSON.stringify([project.id, project.updated_at, project.source_url, project.status, refresh]);
  const projectId = project.id;
  const ready = project.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    api.transcriptEdit(projectId).then((data) => { if (!cancelled) setLoaded({ key, data }); })
      .catch((error: Error) => { if (!cancelled) setLoaded({ key, error: error.message }); });
    return () => { cancelled = true; };
  }, [key, projectId, ready]);
  const data = loaded?.key === key ? loaded.data : undefined;
  const ids = data && selection?.revision === data.revision ? selection.ids : [];
  const chosen = transcriptSelection(data?.segments ?? [], ids);
  const clipJob = jobs.transcript_clip;
  const active = clipJob?.status === "running" || clipJob?.status === "queued";
  const disabled = pending || active || !ready || !data || !!data.blocked_reason;
  const visible = (data?.segments ?? []).filter((row) => row.text.toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr")));

  const cut = async () => {
    if (!data) return;
    setPending(true);
    try {
      setProject(await api.cutTranscript(project.id, { revision: data.revision, segment_ids: ids }));
      setSelection(null);
      notify("Seçili konuşmalar edit planından çıkarıldı. Kaynak korunur; geri alabilirsiniz.");
    } catch (error) { notify((error as Error).message, true); setRefresh((v) => v + 1); setSelection(null); }
    finally { setPending(false); }
  };
  const clip = async () => {
    if (!data) return;
    setPending(true);
    try {
      await track(await api.clipTranscript(project.id, { ...options, revision: data.revision, segment_ids: ids, aspect_ratio: "9:16", fill }),
        () => notify("Transkriptten bağımsız klip hazır; ana proje değiştirilmedi."));
    } catch (error) { notify((error as Error).message, true); setRefresh((v) => v + 1); setSelection(null); }
    finally { setPending(false); }
  };
  const undo = async () => {
    setPending(true);
    try { setProject(await api.undo(project.id, project.edit_revision)); setSelection(null); notify("Son edit adımı geri alındı."); }
    catch (error) { notify((error as Error).message, true); }
    finally { setPending(false); }
  };

  return <div className={styles.section}>
    <header className={pub.intro}><h3>Metinden video düzenle</h3>
      <p>Kaynak transkriptinden satır seçin: konuşmayı görüntü ve sesle birlikte çıkarın veya art arda satırlardan bağımsız klip oluşturun. Metin satırları her zaman tek bir cümleye karşılık gelmeyebilir.</p>
    </header>
    {!ready ? <p className={pub.note}>Önce kaynak videonun hazır olmasını bekleyin.</p> : !loaded || loaded.key !== key ?
      <p role="status" className={pub.note}>Kaynak transkripti yükleniyor…</p> : loaded.error ?
      <p role="alert" className={pub.error}>{loaded.error}</p> : null}
    <button className="btn btn-sm" disabled={pending || active || !ready} onClick={() => { setRefresh((v) => v + 1); setSelection(null); }}>Transkripti yenile</button>
    {data?.blocked_reason && <p role="alert" className={pub.error}>{data.blocked_reason}</p>}
    {data?.mock && <p className={pub.note}>Test transkripti: bu metin gerçek konuşmadan çıkarılmamıştır.</p>}
    {data && !data.segments.length && <p className={pub.note}>Kaynak transkripti yok veya kullanılabilir zamanlı satır bulunamadı. Altyazı panelinden transkript oluşturabilirsiniz; gerçek modda API kullanımı ücretli olabilir.</p>}
    {!!data?.segments.length && <>
      <label className="label" htmlFor="transcript-search">Transkriptte ara · {data.language?.toUpperCase() || "UND"}</label>
      <input id="transcript-search" className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Kelime veya cümle ara" />
      <p className={pub.note}>Kaynak zamanları ve orijinal transkript gösterilir; altyazı çevirisi/metin düzeltmeleri burada kullanılmaz. Arama mevcut seçimi değiştirmez. “Çıkarılmış” satırlar kaynakta durur; render sırasında atlanır.</p>
      <ul className={styles.ops} aria-label="Kaynak transkript satırları">
        {visible.map((row) => <li key={row.id} className={pub.candidate}>
          <label className={pub.candidateLabel}>
            <input type="checkbox" disabled={disabled} checked={ids.includes(row.id)} onChange={() => setSelection({ revision: data.revision, ids: toggleTranscriptRow(ids, row.id) })} />
            {formatTime(row.start)} – {formatTime(row.end)} · {row.start.toFixed(2)}–{row.end.toFixed(2)} sn
          </label>
          <p>{row.text}</p>
          {row.kept_duration < 0.01 ? <small>Çıkarılmış</small> : row.kept_duration < row.end - row.start - 0.01 ? <small>Kısmen çıkarılmış</small> : null}
          <button className="btn btn-sm" onClick={() => seek(row.start)} disabled={!ready}>Kaynakta bu satıra git</button>
        </li>)}
      </ul>
      {!visible.length && <p className={pub.note}>Aramayla eşleşen satır yok.</p>}
      <div className={pub.actions}>
        <button className="btn btn-sm" onClick={() => setSelection(null)} disabled={disabled || !ids.length}>Seçimi temizle</button>
        <button id="transcript-undo" className="btn btn-sm" disabled={disabled || !project.can_undo} onClick={undo}>Son edit adımını geri al</button>
      </div>
      <p role="status" className={pub.note}>{ids.length} satır seçili{ids.length ? ` · kaynak aralığı ${chosen.start.toFixed(2)}–${chosen.end.toFixed(2)} sn` : ""}.</p>
      <p className={pub.note}>Çıkarma kaynak dosyayı ve transkript metnini silmez; edit planına kesim ekler. Kaynak oynatıcısı kesilmemiş halini gösterir; kesin sonucu kısa render önizlemesinde kontrol edin. Zamanlı metin/B-roll/müzik otomatik yeniden hizalanmaz.</p>
      <button id="transcript-cut" className="btn" onClick={cut} disabled={disabled || !ids.length}>Seçili konuşmaları videodan çıkar</button>
      <RenderSettings value={options} onChange={setOptions} fill={fill} onFill={setFill} disabled={disabled} />
      <p className={pub.note}>Klip için art arda satırlar seçin; aradaki duraklamalar da klibe dahil edilir. 9:16 MP4 + ZIP hazırlanır. Kaynak ses ve altyazı/renk stili korunur; ana editteki hız, kesimler, müzik ve zamanlı katmanlar uygulanmaz. Ana proje değişmez; ücretli AI çağrısı yapılmaz.</p>
      {ids.length > 0 && !chosen.contiguous && <p className={pub.note}>Seçim kesintili; klip oluşturmak için aradaki satırları da seçin.</p>}
      <button id="transcript-clip" className="btn" onClick={clip} disabled={disabled || !chosen.contiguous || chosen.end - chosen.start < 0.25}>Seçimden bağımsız klip oluştur</button>
    </>}
    {active && <div role="status" aria-live="polite"><JobProgress job={clipJob} /></div>}
    <PublishingResults job={clipJob} />
  </div>;
}
