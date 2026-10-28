"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { API_URL, api, waitForJob, type Job, type ModelCatalog, type Project } from "@/lib/api";
import GenerationCost from "@/components/editor/GenerationCost";
import styles from "./create.module.css";
import StoryboardForm from "@/components/StoryboardForm";

const STYLES = [
  { label: "Sinematik", text: "cinematic lighting, shallow depth of field, 35mm film look" },
  { label: "Drone", text: "aerial drone shot, smooth slow motion" },
  { label: "Ürün", text: "studio product shot, soft key light, rotating turntable" },
  { label: "Anime", text: "anime style, vibrant colors, dynamic camera" },
  { label: "Belgesel", text: "documentary style, natural light, handheld camera" },
  { label: "Neon", text: "neon cyberpunk city at night, rain reflections" },
];

const EXAMPLES = [
  "Gün batımında İstanbul Boğazı üzerinde süzülen bir martı, altın saat ışığı",
  "Minimalist beyaz masada dönen yeni nesil kablosuz kulaklık, stüdyo ışığı",
  "Yağmurlu bir gecede neon tabelalarla dolu sokakta yürüyen bir kadın",
];

const PRESET_TEMPLATES = [
  { label: "🔥 TikTok Viral", prompt: "TikTok için dinamik ve enerjik ürün tanıtımı, renkli neon ışıklar", aspect: "9:16" as const },
  { label: "💡 Shorts Eğitici", prompt: "Açık ve aydınlık stüdyo ortamında bilgi anlatan modern konuşmacı", aspect: "9:16" as const },
  { label: "🛍️ Ürün Reklamı", prompt: "Minimalist kaide üzerinde 360 derece dönen şık teknolojik ürün", aspect: "9:16" as const },
  { label: "🎬 Sinematik", prompt: "Altın saat gün batımında dağ yamacında süzülen sinematik kamera", aspect: "16:9" as const },
];

type Tab = "storyboard" | "generate" | "upload";

export default function CreatePage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("storyboard");
  const [error, setError] = useState<string | null>(null);

  // generate
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("9:16");
  const [duration, setDuration] = useState(8);
  const [name, setName] = useState("");
  const [styleTags, setStyleTags] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const generation = useRef<AbortController | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [videoModel, setVideoModel] = useState("");
  const [budget, setBudget] = useState("");

  // upload
  const [file, setFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = starting || (job && job.status !== "failed") || uploadPct !== null;

  useEffect(() => () => { generation.current?.abort(); }, []);

  useEffect(() => {
    api.aiModels().then((value) => {
      setCatalog(value);
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

  const toggleStyle = (text: string) =>
    setStyleTags((s) => (s.includes(text) ? s.filter((x) => x !== text) : [...s, text]));

  const generate = async () => {
    if (generation.current) return;
    const controller = new AbortController();
    generation.current = controller;
    setStarting(true);
    setError(null);
    const full = [prompt.trim(), ...styleTags].filter(Boolean).join(", ");
    try {
      const { project, job } = await api.generate({
        prompt: full,
        name: name || prompt.slice(0, 48),
        aspect_ratio: aspect,
        duration,
        negative_prompt: negative || undefined,
        video_model: videoModel || undefined,
        max_cost_usd: budget.trim() === "" ? undefined : Number(budget),
      });
      if (controller.signal.aborted) return;
      setJob(job);
      const final = await waitForJob(job.id, setJob, 1500, { signal: controller.signal,
        onConnectionChange: (connected) => setError(connected ? null :
          "Bağlantı kesildi; üretim yeniden başlatılmadan iş takibi tekrar denenecek."),
      });
      if (final.status === "done") router.push(`/editor/${project.id}`);
      else setError(final.error || "Video üretilemedi.");
    } catch (e) {
      if (controller.signal.aborted) return;
      setError((e as Error).message);
      setJob(null);
    } finally {
      if (generation.current === controller) generation.current = null;
      if (!controller.signal.aborted) setStarting(false);
    }
  };

  const upload = () => {
    if (!file) return;
    setError(null);
    setUploadPct(0);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", uploadName || file.name.replace(/\.[^.]+$/, ""));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/projects/upload`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploadPct(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const p = JSON.parse(xhr.responseText) as Project;
        router.push(`/editor/${p.id}`);
      } else {
        let msg = "Yükleme başarısız.";
        try {
          msg = JSON.parse(xhr.responseText).detail ?? msg;
        } catch {}
        setError(msg);
        setUploadPct(null);
      }
    };
    xhr.onerror = () => {
      setError("Backend’e ulaşılamadı.");
      setUploadPct(null);
    };
    xhr.send(fd);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };

  return (
    <main className={`container ${styles.page}`}>
      <div className={`${styles.head} fade-in`}>
        <h1>
          Yeni <span className="gradient-text">video</span> oluştur
        </h1>
        <p>Yapay zeka ile sıfırdan üret ya da elindeki videoyu yükleyip düzenlemeye başla.</p>
      </div>

      <div className={styles.tabs} role="tablist">
        <button role="tab" id="tab-storyboard" aria-selected={tab === "storyboard"}
          className={`${styles.tab} ${tab === "storyboard" ? styles.tabActive : ""}`} onClick={() => setTab("storyboard")} disabled={!!busy}>
          Senaryodan Üret
        </button>
        <button
          role="tab"
          id="tab-generate"
          aria-selected={tab === "generate"}
          className={`${styles.tab} ${tab === "generate" ? styles.tabActive : ""}`}
          onClick={() => setTab("generate")}
          disabled={!!busy}
        >
          ✦ Tek Sahne Üret
        </button>
        <button
          role="tab"
          id="tab-upload"
          aria-selected={tab === "upload"}
          className={`${styles.tab} ${tab === "upload" ? styles.tabActive : ""}`}
          onClick={() => setTab("upload")}
          disabled={!!busy}
        >
          ⬆ Video Yükle
        </button>
      </div>

      {tab === "storyboard" ? <StoryboardForm /> : tab === "generate" ? (
        <section className={`${styles.panel} glass fade-in`}>
          <div className={styles.cols}>
            <div className={styles.form}>
              <div>
                <label className="label" htmlFor="gen-prompt">
                  Sahneyi anlat
                </label>
                <textarea
                  id="gen-prompt"
                  className="textarea"
                  rows={5}
                  placeholder="Örn: Sisli bir orman, sabah güneşi ağaçların arasından süzülüyor, kamera yavaşça ilerliyor…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={!!busy}
                />
                <div className={styles.presetRow}>
                  <span className="label" style={{ marginBottom: 0 }}>Hazır şablonlar:</span>
                  {PRESET_TEMPLATES.map((pt) => (
                    <button
                      key={pt.label}
                      className="chip"
                      style={{ cursor: "pointer", borderColor: "hsla(262, 90%, 70%, 0.4)" }}
                      onClick={() => {
                        setPrompt(pt.prompt);
                        setAspect(pt.aspect);
                      }}
                      disabled={!!busy}
                    >
                      {pt.label}
                    </button>
                  ))}
                </div>

                <div className={styles.examples}>
                  {EXAMPLES.map((ex) => (
                    <button key={ex} className="chip" onClick={() => setPrompt(ex)} disabled={!!busy}>
                      {ex.slice(0, 38)}…
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="label">Görsel stil</span>
                <div className={styles.styleGrid}>
                  {STYLES.map((s) => (
                    <button
                      key={s.label}
                      id={`style-${s.label}`}
                      className={`${styles.styleBtn} ${styleTags.includes(s.text) ? styles.styleOn : ""}`}
                      onClick={() => toggleStyle(s.text)}
                      disabled={!!busy}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="label" htmlFor="gen-negative">
                  İstenmeyenler (opsiyonel)
                </label>
                <input
                  id="gen-negative"
                  className="input"
                  placeholder="bulanık, yazı, filigran…"
                  value={negative}
                  onChange={(e) => setNegative(e.target.value)}
                  disabled={!!busy}
                />
              </div>
            </div>

            <aside className={styles.side}>
              <div>
                <span className="label">Format</span>
                <div className={styles.aspects}>
                  {(["9:16", "16:9"] as const).map((a) => (
                    <button
                      key={a}
                      id={`aspect-${a.replace(":", "x")}`}
                      className={`${styles.aspect} ${aspect === a ? styles.aspectOn : ""}`}
                      onClick={() => setAspect(a)}
                      disabled={!!busy}
                    >
                      <span className={styles.aspectBox} style={a === "9:16" ? { width: 18, height: 32 } : { width: 36, height: 20 }} />
                      {a}
                      <small>{a === "9:16" ? "Reels · TikTok" : "YouTube"}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label" htmlFor="gen-duration">
                  Süre
                </label>
                <select
                  id="gen-duration"
                  className="select"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  disabled={!!busy}
                >
                  {[4, 6, 8].map((value) => (
                    <option key={value} value={value} disabled={!durations.includes(value)}>{value} saniye</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="gen-name">
                  Proje adı
                </label>
                <input
                  id="gen-name"
                  className="input"
                  placeholder="Otomatik"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!!busy}
                />
              </div>

              <GenerationCost
                catalog={catalog}
                videoModel={videoModel}
                textModel={catalog?.defaults.text_model ?? ""}
                onVideoModel={changeVideoModel}
                sceneDurations={[duration]}
                budget={budget}
                onBudget={setBudget}
                disabled={!!busy}
                compact
              />

              {job && job.status !== "failed" ? (
                <div className={styles.progressBox}>
                  <div className={styles.progressHead}>
                    <span>{job.message}</span>
                    <span>{Math.round(job.progress * 100)}%</span>
                  </div>
                  <div className="progress">
                    <span style={{ width: `${Math.max(4, job.progress * 100)}%` }} />
                  </div>
                  <small>Veo üretimi 1–3 dakika sürebilir.</small>
                </div>
              ) : (
                <button
                  id="generate-submit"
                  className="btn btn-primary btn-lg"
                  onClick={generate}
                  disabled={prompt.trim().length < 3}
                >
                  ✦ Videoyu Üret
                </button>
              )}
            </aside>
          </div>
        </section>
      ) : (
        <section className={`${styles.panel} glass fade-in`}>
          <div
            id="upload-dropzone"
            className={`${styles.drop} ${drag ? styles.dropActive : ""} ${file ? styles.dropHasFile : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() => !busy && inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              hidden
              id="upload-input"
              onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])}
            />
            <span className={styles.dropIcon}>{file ? "🎞️" : "⬆"}</span>
            {file ? (
              <>
                <strong>{file.name}</strong>
                <span>{(file.size / 1024 / 1024).toFixed(1)} MB · değiştirmek için tıkla</span>
              </>
            ) : (
              <>
                <strong>Videonu buraya sürükle</strong>
                <span>veya seçmek için tıkla · MP4, MOV, MKV, WEBM</span>
              </>
            )}
          </div>
          <div className={styles.uploadRow}>
            <input
              id="upload-name"
              className="input"
              placeholder="Proje adı (opsiyonel)"
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              disabled={!!busy}
            />
            {uploadPct !== null ? (
              <div className={styles.uploadProgress}>
                <div className="progress">
                  <span style={{ width: `${uploadPct}%` }} />
                </div>
                <small>{uploadPct < 100 ? `Yükleniyor %${uploadPct}` : "Video analiz ediliyor…"}</small>
              </div>
            ) : (
              <button id="upload-submit" className="btn btn-primary btn-lg" disabled={!file} onClick={upload}>
                Yükle ve Düzenle →
              </button>
            )}
          </div>
        </section>
      )}

      {error && <div className="toast toast-error">⚠ {error}</div>}
    </main>
  );
}
