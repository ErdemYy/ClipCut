"use client";

import { useEffect, useState } from "react";
import { api, mediaUrl, type Health, type Job, type JobMap, type Project, type Storyboard, type StoryScene, type Voice } from "@/lib/api";
import { JobProgress } from "./SubtitlePanel";
import styles from "./storyboard.module.css";

function editable(s: Storyboard) {
  return { title: s.title, aspect_ratio: s.aspect_ratio, language: s.language, style: s.style, continuity: s.continuity,
    voiceover: s.voiceover, voice_id: s.voice_id, auto_subtitles: s.auto_subtitles,
    scenes: s.scenes.map(({ id, title, visual_prompt, narration, duration, trim_start, trim_end, transition, transition_duration }) =>
      ({ id, title, visual_prompt, narration, duration, trim_start, trim_end, transition, transition_duration })) };
}
const STATUS = { pending: "Bekliyor", generating: "Üretiliyor", ready: "Hazır", failed: "Başarısız" };

export default function StoryboardPanel({ project, setProject, draft, setDraft, pending, setPending, jobs, track, notify }: {
  project: Project; setProject: (p: Project) => void; jobs: JobMap;
  draft: Storyboard; setDraft: (draft: Storyboard) => void;
  pending: boolean; setPending: (value: boolean) => void;
  track: (job: Job, onDone?: (j: Job) => void) => Promise<void>; notify: (text: string, error?: boolean) => void;
}) {
  const story = project.storyboard!;
  const [health, setHealth] = useState<Health | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [approved, setApproved] = useState(false);
  const [replaceApproved, setReplaceApproved] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreApproved, setRestoreApproved] = useState(false);
  const dirty = JSON.stringify(editable(draft)) !== JSON.stringify(editable(story));
  const job = jobs.storyboard_generate;
  const busy = pending || project.status === "generating" || job?.status === "queued" || job?.status === "running";
  const running = job?.status === "running" || job?.status === "queued";
  const invalid = !draft.title.trim() || !draft.style.trim() || draft.scenes.some((s) => !s.title.trim() || s.visual_prompt.trim().length < 3 || (draft.voiceover && !s.narration.trim()));

  useEffect(() => {
    api.health().then(setHealth).catch((e: Error) => notify(e.message, true));
    api.voices().then(setVoices).catch((e: Error) => notify(e.message, true));
  }, [notify]);
  // While production runs, refresh the project so the control center tracks the active scene.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const fresh = await api.project(project.id);
        if (alive) setProject(fresh);
      } catch { /* brief network hiccup; next tick retries */ }
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [running, project.id, setProject]);
  const patchScene = (id: string, values: Partial<StoryScene>) => setDraft({ ...draft, scenes: draft.scenes.map((scene) => scene.id === id ?
    { ...scene, ...values, ...("visual_prompt" in values || "narration" in values || "duration" in values ? { trim_start: 0, trim_end: null } : {}) } : scene) });
  const move = (index: number, direction: number) => {
    const scenes = [...draft.scenes]; [scenes[index], scenes[index + direction]] = [scenes[index + direction], scenes[index]];
    setDraft({ ...draft, scenes });
  };
  const save = async () => {
    setPending(true);
    try { setProject(await api.saveStoryboard(project.id, draft)); notify("Sahne planı kaydedildi; değişmeyen sahneler korunur."); }
    catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };
  const generate = async (sceneId?: string) => {
    setPending(true);
    try {
      const j = await api.generateStoryboard(project.id, { revision: story.revision, scene_id: sceneId, confirm_api_usage: approved, confirm_replace_source: replaceApproved });
      await track(j, (final) => {
        const r = final.result as { assembled?: boolean; stopped?: boolean; message?: string } | null;
        if (r?.stopped) notify(r.message || "Üretim durduruldu; hazır sahneler korunuyor.");
        else if (final.result?.assembled) notify("Sahneler birleştirildi. Video editöre hazır.");
        else notify("Seçilen sahne hazır; kalan sahneleri tamamlayabilirsiniz.");
      });
    } catch (e) { notify((e as Error).message, true); }
    finally { setPending(false); }
  };
  const stop = async () => {
    if (!job) return;
    setStopping(true);
    try {
      await api.cancelJob(job.id);
      notify("Durdurma istendi; sürmekte olan sahne bitince kalan sahneler atlanır.");
    } catch (e) { notify((e as Error).message, true); }
    finally { setStopping(false); }
  };
  const restore = async (versionIndex: number) => {
    setRestoring(true);
    try {
      const p = await api.restoreStoryboardVersion(project.id, { version_index: versionIndex, confirm: true });
      setProject(p);
      setRestoreApproved(false);
      notify("Sürüm geri yüklendi; önceki durum korunan sürümlere arşivlendi.");
    } catch (e) { notify((e as Error).message, true); }
    finally { setRestoring(false); }
  };
  const active = story.scenes.find((s) => s.status === "generating");
  const remaining = story.scenes.filter((s) => s.status !== "ready").length;
  const canGenerate = !busy && !dirty && !invalid && !!health && (!project.source_url || replaceApproved);

  return <div className={styles.panel}>
    <header className={styles.intro}><h3>Sahne planı</h3>
      <p>Görsel zaman çizelgesinden sıralama, kırpma ve geçişleri yönetebilirsiniz. Önce kaydedin, ardından yerel olarak yeniden birleştirin. Kırpma/sıralama/geçiş yeni AI üretimi başlatmaz. Üretim ayarı değiştirilen sahnenin kırpması sıfırlanır. Geçiş süresi kısa sahnelerde otomatik olarak sınırlanır.</p>
      {story.mock_plan && <p className={styles.note}>Bu plan demo modunda mekanik olarak oluşturuldu; gerçek AI senaryo yazımı veya çeviri değildir.</p>}
    </header>
    <div className={styles.formGrid}>
      <label className={styles.wide}>Video başlığı<input className="input" maxLength={120} value={draft.title} disabled={busy} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>Format<select className="select" value={draft.aspect_ratio} disabled={busy} onChange={(e) => setDraft({ ...draft, aspect_ratio: e.target.value as Storyboard["aspect_ratio"], scenes: draft.scenes.map((s) => ({ ...s, trim_start: 0, trim_end: null })) })}>
        <option value="9:16">9:16 · Dikey</option><option value="16:9">16:9 · Yatay</option>
      </select></label>
      <label>Anlatım dili<select className="select" value={draft.language} disabled={busy} onChange={(e) => {
        const lang = e.target.value as Storyboard["language"];
        setDraft({ ...draft, language: lang, voice_id: voices.find((v) => v.language === lang)?.id || draft.voice_id, scenes: draft.scenes.map((s) => ({ ...s, trim_start: 0, trim_end: null })) });
      }}><option value="tr">Türkçe</option><option value="en">English</option><option value="de">Deutsch</option><option value="es">Español</option></select></label>
      <label className={styles.wide}>Ortak görsel stil<input className="input" maxLength={500} value={draft.style} disabled={busy} onChange={(e) => setDraft({ ...draft, style: e.target.value, scenes: draft.scenes.map((s) => ({ ...s, trim_start: 0, trim_end: null })) })} /></label>
      <label className={styles.wide}>Karakter ve sahne tutarlılığı<textarea className="textarea" rows={3} maxLength={1500} value={draft.continuity} disabled={busy}
        onChange={(e) => setDraft({ ...draft, continuity: e.target.value, scenes: draft.scenes.map((s) => ({ ...s, trim_start: 0, trim_end: null })) })} placeholder="Aynı karakterin görünüşü, ürün rengi, mekân, kamera dili…" /></label>
    </div>
    <label className={styles.check}><input type="checkbox" checked={draft.voiceover} disabled={busy} onChange={(e) => setDraft({ ...draft, voiceover: e.target.checked, scenes: draft.scenes.map((s) => ({ ...s, trim_start: 0, trim_end: null })) })} />Sahne anlatımlarını Edge TTS ile seslendir (kaynak sahne sesi yerine)</label>
    {draft.voiceover && <>
      <label>Ses<select className="select" value={draft.voice_id} disabled={busy || voices.length === 0} onChange={(e) => setDraft({ ...draft, voice_id: e.target.value, scenes: draft.scenes.map((s) => ({ ...s, trim_start: 0, trim_end: null })) })}>
        {voices.filter((v) => v.language === draft.language).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.style}</option>)}
      </select></label>
      <label className={styles.check}><input type="checkbox" checked={draft.auto_subtitles} disabled={busy} onChange={(e) => setDraft({ ...draft, auto_subtitles: e.target.checked })} />Birleştirilmiş videoda otomatik altyazı stilini aç</label>
    </>}
    {draft.scenes.map((scene, index) => {
      const state = story.scenes.find((s) => s.id === scene.id)!;
      return <section className={styles.scene} key={scene.id} aria-label={`Sahne ${index + 1}`}>
        <div className={styles.sceneHead}><h4>{index + 1}. sahne</h4><span className="chip">{STATUS[state.status]}</span></div>
        <div className={styles.actions}>
          <button className="btn btn-sm" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Sahne ${index + 1} yukarı`}>↑ Yukarı</button>
          <button className="btn btn-sm" disabled={busy || index === draft.scenes.length - 1} onClick={() => move(index, 1)} aria-label={`Sahne ${index + 1} aşağı`}>↓ Aşağı</button>
        </div>
        {index > 0 && <div className={styles.formGrid}>
          <label>Önceki sahneden geçiş<select className="select" value={scene.transition} disabled={busy}
            onChange={(e) => patchScene(scene.id, { transition: e.target.value as StoryScene["transition"] })}>
            <option value="cut">Sert kesme</option>
            <option value="dissolve">Çözünme (crossfade)</option>
            <option value="fade">Kararmadan geçiş</option>
          </select></label>
          {scene.transition !== "cut" && <label>Geçiş süresi · {scene.transition_duration.toFixed(1)} sn
            <input type="range" min={0.2} max={2} step={0.1} value={scene.transition_duration} disabled={busy}
              onChange={(e) => patchScene(scene.id, { transition_duration: Number(e.target.value) })} /></label>}
        </div>}
        <label>Başlık<input className="input" value={scene.title} maxLength={120} disabled={busy} onChange={(e) => patchScene(scene.id, { title: e.target.value })} /></label>
        <label>Görsel prompt<textarea className="textarea" value={scene.visual_prompt} rows={3} maxLength={2000} disabled={busy} onChange={(e) => patchScene(scene.id, { visual_prompt: e.target.value })} /></label>
        <label>Anlatım metni<textarea className="textarea" value={scene.narration} rows={2} maxLength={1000} disabled={busy} onChange={(e) => patchScene(scene.id, { narration: e.target.value })} /></label>
        <label>Görsel üretim süresi<select className="select" value={scene.duration} disabled={busy} onChange={(e) => patchScene(scene.id, { duration: Number(e.target.value) as StoryScene["duration"] })}>
          {[4, 6, 8].map((n) => <option key={n} value={n} disabled={!!health?.video_durations && !health.video_durations.includes(n)}>{n} saniye</option>)}
        </select></label>
        {draft.voiceover && scene.narration.split(/\s+/).length > scene.duration * 3 && <p className={styles.note}>Anlatım bu süre için uzun olabilir. Metni kısaltın; gerekirse son kare anlatım bitene kadar tutulur.</p>}
        {state.video_url && <video controls preload="none" src={mediaUrl(state.video_url)} aria-label={`${scene.title} önizlemesi`} />}
        {state.mock && <small className={styles.note}>Demo görsel / {draft.voiceover ? "konuşma yerine sentetik ton" : "demo ses"}</small>}
        {state.actual_duration && <small className={styles.note}>Gerçek sahne süresi: {state.actual_duration.toFixed(1)} sn</small>}
        {state.error && <p className={styles.error} role="alert">{state.error}</p>}
        <button className="btn btn-sm" disabled={!canGenerate || (!health?.mock && !approved)} onClick={() => generate(scene.id)}>
          {state.status === "ready" ? "Yalnızca bu sahneyi yeniden üret" : "Yalnızca bu sahneyi üret"}
        </button>
      </section>;
    })}
    <button id="storyboard-save" className="btn" disabled={busy || !dirty || invalid} onClick={save}>Sahne planını kaydet</button>
    {dirty && <p className={styles.note}>Kaydedilmemiş değişiklikler var. Üretimden önce kaydedin. Dil seçimi mevcut anlatım metinlerini otomatik çevirmez.</p>}
    <p className={styles.note}>{draft.scenes.length} sahne · planlanan {draft.scenes.reduce((t, s) => t + s.duration, 0)} sn · kayıtlı plan geçişlerle {story.timeline_duration.toFixed(2)} sn · {story.pending_scenes} sahne hazır değil. Görsel tutarlılığı ortak promptlarla teşvik edilir; kimlik tutarlılığı garanti edilmez.</p>
    {health?.video_model_warning && <p className={styles.note}>{health.video_model_warning}</p>}
    {health?.mock ? <p className={styles.note}>Demo: gerçek API çağrısı yapılmaz. Gerçek modda seslendirme başarısızsa işlem durur; konuşma yerine demo tonu konmaz.</p> : health && <label className={styles.check}>
      <input type="checkbox" checked={approved} disabled={busy} onChange={(e) => setApproved(e.target.checked)} />
      Eksik sahneler için planlanan {story.pending_scenes} video üretimini ve seçili seslendirmeyi onaylıyorum. Görsel promptlar Google’a, seslendirme metinleri açıksa Edge TTS servisine gönderilir. Tek sahne yeniden üretimi ek 1 video üretimi başlatır. Sonucu alınamayan istek sağlayıcıda ücretlenmiş olabilir; yeniden deneme ek ücret doğurabilir. Kesin tutar sağlayıcıya bağlıdır.
    </label>}
    {project.source_url && <label className={styles.check}>
      <input type="checkbox" checked={replaceApproved} disabled={busy} onChange={(e) => setReplaceApproved(e.target.checked)} />
      Birleştirme sonrası edit kaynağının değişmesini onaylıyorum. Önceki video ve edit verileri korunur; mevcut zamanlı editler yeni videoya otomatik taşınmaz.
    </label>}
    {running && <section className={styles.control} role="status" aria-label="Üretim kontrol merkezi">
      <div className={styles.controlHead}>
        <strong>{active ? `Üretiliyor: ${active.title}` : "Üretim kuyrukta"}</strong>
        <span>{remaining > 0 ? `${remaining} sahne kaldı` : "Son sahne"}</span>
      </div>
      <JobProgress job={job} />
      <button className="btn" disabled={stopping} onClick={stop}>Kalan üretimi durdur</button>
      <p className={styles.note}>Durdurma sürmekte olan sahnenin bitmesini bekler; o sahne için sağlayıcıya başlatılmış istek ücretlenmiş olabilir. Bitmiş sahneler kullanılabilir kalır, kalan sahneler atlanır ve bu çalışmada video henüz birleştirilmez. Tekrar başlatırsanız yalnızca kalan sahneler üretilir.</p>
    </section>}
    {story.last_error && <p className={styles.error} role="alert">{story.last_error} Hazır sahneler korunur; devam etmeyi deneyebilirsiniz.</p>}
    <button id="storyboard-generate" className="btn btn-primary" disabled={!canGenerate || (!health?.mock && story.pending_scenes > 0 && !approved)} onClick={() => generate()}>
      {busy ? "Sahne üretimi sürüyor…" : story.pending_scenes ? `Kalan ${story.pending_scenes} sahneyi üret ve birleştir` : "Hazır sahneleri yeniden birleştir (video API çağrısı yok)"}
    </button>
    {story.pending_scenes > 0 && !busy && <p className={styles.note}>Kalan sahneler için yeni bir üretim başlatır; hazır ve değişmemiş sahneler yeniden üretilmez, tümü bittiğinde otomatik birleştirilir.</p>}
    {project.source_url && story.assembled_revision !== story.revision && <p className={styles.note}>Editörde görünen video önceki plana aittir; yeni plan henüz birleştirilmedi.</p>}
    {story.previous_versions.length > 0 && <section className={styles.versions}><h4>Korunan sürümler</h4>
      <p className={styles.note}>En fazla 6 sürüm listelenir; dosyalar silinmez. Geri yükleme o birleştirme anındaki kaynak videoyu, edit durumunu (plan/altyazı) ve sahne planını getirir; şimdiki durum önce bir sürüm olarak korunur.</p>
      <label className={styles.check}>
        <input type="checkbox" checked={restoreApproved} onChange={(e) => setRestoreApproved(e.target.checked)} />
        Geri yüklemenin editörün mevcut kaynak, edit ve sahne planı durumunu değiştirmesini onaylıyorum.
      </label>
      {story.previous_versions.map((v) => <div key={v.source_url} className={styles.versionRow}>
        <a className="btn btn-sm" href={mediaUrl(v.source_url)} target="_blank" rel="noreferrer">{new Date(v.created_at).toLocaleString("tr-TR")} · Korunan video</a>
        {v.restorable && <button className="btn btn-sm" disabled={!restoreApproved || busy || restoring} onClick={() => restore(v.index)}>Bu sürümü geri yükle</button>}
        {!v.restorable && <span className={styles.note}>Eski arşiv biçimi: plan kopyası yok, yalnızca videoyu açar.</span>}
      </div>)}
    </section>}
  </div>;
}
