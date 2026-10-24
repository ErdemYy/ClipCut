"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type Health, type ModelCatalog } from "@/lib/api";
import GenerationCost from "./editor/GenerationCost";
import styles from "./editor/storyboard.module.css";

export default function StoryboardForm() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState(4);
  const [duration, setDuration] = useState(8);
  const [aspect, setAspect] = useState("9:16");
  const [language, setLanguage] = useState("tr");
  const [style, setStyle] = useState("cinematic, natural lighting");
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [textModel, setTextModel] = useState("");
  const [videoModel, setVideoModel] = useState("");
  const [approved, setApproved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e: Error) => setError(e.message));
    api.aiModels().then((value) => {
      setCatalog(value);
      setTextModel((current) => current || value.defaults.text_model);
      setVideoModel((current) => current || value.defaults.video_model);
    }).catch((e: Error) => setError(e.message));
  }, []);
  const selectedVideo = catalog?.video.find((model) => model.id === videoModel);
  const durations = selectedVideo?.durations?.length ? selectedVideo.durations : [4, 6, 8];
  const changeVideoModel = (id: string) => {
    setVideoModel(id);
    const next = catalog?.video.find((model) => model.id === id)?.durations ?? [4, 6, 8];
    if (!next.includes(duration)) setDuration(next[next.length - 1] ?? 8);
  };
  const create = async () => {
    setPending(true); setError(null);
    try {
      const project = await api.createStoryboard({ brief, scene_count: count, scene_duration: duration, aspect_ratio: aspect,
        language, style, text_model: textModel || undefined, video_model: videoModel || undefined,
        confirm_api_usage: approved });
      router.push(`/editor/${project.id}`);
    } catch (e) { setError((e as Error).message); setPending(false); }
  };

  return <section className={styles.studio} aria-label="Senaryodan çok sahneli video">
    <header className={styles.intro}>
      <span className="chip">1. Planla → 2. İncele → 3. Üret</span>
      <h2>Bir konudan bütünlüklü videoya</h2>
      <p>Konuyu ya da hazır senaryonuzu yazın. Önce sahneler, görsel promptlar ve anlatım metinleri hazırlanır. Videolar ancak planı inceleyip üretimi onayladıktan sonra oluşturulur.</p>
    </header>
    <div className={styles.formGrid}>
      <label className={styles.wide}>Konu veya hazır senaryo
        <textarea id="storyboard-brief" className="textarea" rows={7} maxLength={6000} placeholder="Örn: Evde kahve demlemenin üç sırrını anlatan kısa bir video. İlk sahnede dikkat çekici bir soru, ardından üç pratik ipucu…"
          value={brief} onChange={(e) => setBrief(e.target.value)} disabled={pending} />
      </label>
      <label>Sahne sayısı<select className="select" value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={pending}>
        {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} sahne</option>)}
      </select></label>
      <label>Sahne süresi<select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={pending}>
        {[4, 6, 8].map((n) => <option key={n} value={n} disabled={!durations.includes(n)}>{n} saniye</option>)}
      </select></label>
      <label>Platform<select className="select" value={aspect} onChange={(e) => setAspect(e.target.value)} disabled={pending}>
        <option value="9:16">9:16 · Reels / TikTok / Shorts</option><option value="16:9">16:9 · YouTube</option>
      </select></label>
      <label>Anlatım dili<select className="select" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={pending}>
        <option value="tr">Türkçe</option><option value="en">English</option><option value="de">Deutsch</option><option value="es">Español</option>
      </select></label>
      <label className={styles.wide}>Ortak görsel stil<input className="input" maxLength={500} value={style} onChange={(e) => setStyle(e.target.value)} disabled={pending} /></label>
    </div>
    <p className={styles.note}>Planlanan süre: <strong>{count * duration} saniye</strong> · {count} sahne. Anlatım daha uzunsa son kare anlatım bitene kadar tutulur; sahne en fazla 30 sn olabilir.</p>
    <GenerationCost catalog={catalog} videoModel={videoModel} textModel={textModel} onVideoModel={changeVideoModel}
      onTextModel={setTextModel} planningSceneCount={count} planningChars={brief.length}
      showBudget={false} disabled={pending} />
    {health?.video_model_warning && <p className={styles.note}>{health.video_model_warning}</p>}
    {health?.mock ? <p className={styles.note}>Demo modu: plan mekanik bir taslaktır; videolar demo görselleri, seslendirme konuşma yerine sentetik tondur. API çağrısı yapılmaz.</p> : health && <label className={styles.check}>
      <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} disabled={pending} />
      Plan için 1 gerçek AI metin çağrısını onaylıyorum. Ücret sağlayıcıya bağlıdır; bu adım video üretmez.
    </label>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button id="storyboard-plan" className="btn btn-primary btn-lg" onClick={create} disabled={pending || !health || brief.trim().length < 3 || !style.trim() || (!health.mock && !approved)}>
      {pending ? "Sahne planı hazırlanıyor…" : "Önce sahne planını hazırla"}
    </button>
  </section>;
}
