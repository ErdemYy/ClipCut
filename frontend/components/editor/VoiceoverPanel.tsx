"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, mediaUrl, type Project, type Voice } from "@/lib/api";
import styles from "./editor-parts.module.css";

type Props = {
  project: Project;
  setProject: (p: Project) => void;
  notify: (t: string, e?: boolean) => void;
  disabled: boolean;
};

const HOOK_PRESETS = [
  {
    label: "Viral Shorts Kancası",
    text: "Bunu çoğu insan bilmiyor ama yapay zeka ile video üretmek artık sadece saniyeler sürüyor!",
  },
  {
    label: "Ürün Tanıtımı",
    text: "Eğer işinizi büyütmek istiyorsanız bu yeni çözüme mutlaka göz atmalısınız. Sonuçlar inanılmaz!",
  },
  {
    label: "Motivasyon Sözü",
    text: "Her büyük başarı, pes etmeyi reddeden bir hayalperestin cesaretiyle başlar.",
  },
  {
    label: "Bilgilendirici Video",
    text: "Bugün 3 basit adımda profesyonel içerik üreticisinin sırlarını inceliyoruz. Hazırsanız başlayalım!",
  },
];

export default function VoiceoverPanel({ project, setProject, notify, disabled }: Props) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("tr-TR-EmelNeural");
  const [text, setText] = useState<string>("");
  const [speed, setSpeed] = useState<number>(1.0);
  const [autoSubtitles, setAutoSubtitles] = useState<boolean>(true);
  const [subStyle, setSubStyle] = useState<string>("karaoke");

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDur, setPreviewDur] = useState<number | null>(null);

  const [applying, setApplying] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeVoAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingActive, setIsPlayingActive] = useState(false);

  useEffect(() => {
    api
      .voices()
      .then((data) => {
        setVoices(data);
        if (data.length > 0 && !data.some((v) => v.id === selectedVoice)) {
          setSelectedVoice(data[0].id);
        }
      })
      .catch(() => {});
  }, [selectedVoice]);

  // Tahmini süre hesabı (kelime başı ortalama ~0.43 saniye)
  const estSeconds = useMemo(() => {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) return 0;
    return Math.round(((wordCount * 0.43) / speed) * 10) / 10;
  }, [text, speed]);

  const handlePreview = async () => {
    if (!text.trim()) {
      notify("Lütfen önce seslendirilecek bir metin girin.", true);
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await api.previewVoiceover({
        text: text.trim(),
        voice: selectedVoice,
        speed,
      });
      setPreviewUrl(res.url);
      setPreviewDur(res.duration);
      notify(`Önizleme hazırlandı (${res.duration}s).`);
      setTimeout(() => {
        if (previewAudioRef.current) {
          previewAudioRef.current.play().catch(() => {});
        }
      }, 100);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (disabled || applying) return;
    if (!text.trim()) {
      notify("Lütfen seslendirilecek bir metin yazın.", true);
      return;
    }
    setApplying(true);
    try {
      const res = await api.applyVoiceover(project.id, {
        text: text.trim(),
        voice: selectedVoice,
        speed,
        auto_subtitles: autoSubtitles,
        subtitle_style: subStyle,
      });
      setProject(res.project);
      notify("🎙️ Seslendirme videoya başarıyla uygulandı!");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setApplying(false);
    }
  };

  const handleDelete = async () => {
    if (disabled || deleting) return;
    setDeleting(true);
    try {
      const res = await api.deleteVoiceover(project.id);
      setProject(res.project);
      setIsPlayingActive(false);
      notify("Seslendirme videodan kaldırıldı.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setDeleting(false);
    }
  };

  const toggleActiveAudio = () => {
    if (!activeVoAudioRef.current) return;
    if (isPlayingActive) {
      activeVoAudioRef.current.pause();
      setIsPlayingActive(false);
    } else {
      activeVoAudioRef.current.currentTime = 0;
      activeVoAudioRef.current.play().catch(() => {});
      setIsPlayingActive(true);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.hero}>
        <span>🎙️</span>
        <h3>AI Seslendirme Stüdyosu</h3>
        <p>
          Doğal sinirsel seslerle metni konuşmaya dönüştürün. Otomatik kelime zamanlamasıyla altyazılarınız videoyla kusursuz senkronize olsun.
        </p>
      </div>

      {project.voiceover_url && (
        <div className={styles.currentVoBanner} id="active-voiceover-banner">
          <div>
            <strong>✓ Aktif AI Seslendirme</strong>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Video önizlemesinde ve render çıktısında bu ses çalacaktır.
            </p>
            <audio
              ref={activeVoAudioRef}
              src={mediaUrl(project.voiceover_url)}
              onEnded={() => setIsPlayingActive(false)}
            />
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <button className="btn btn-ghost btn-sm" onClick={toggleActiveAudio} id="btn-play-active-vo">
              {isPlayingActive ? "⏸ Durdur" : "▶ Dinle"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleDelete}
              disabled={deleting}
              id="btn-delete-vo"
              style={{ color: "#ff6b6b" }}
            >
              {deleting ? "Kaldırılıyor…" : "🗑️ Kaldır"}
            </button>
          </div>
        </div>
      )}

      {/* Ses Seçici */}
      <div className={styles.block}>
        <label className={styles.label}>
          <span>Seslendirici / Ton</span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>
            {voices.length} Farklı Ses
          </span>
        </label>
        <div className={styles.voiceGrid}>
          {voices.map((v) => {
            const isActive = v.id === selectedVoice;
            return (
              <div
                key={v.id}
                className={`${styles.voiceCard} ${isActive ? styles.voiceCardActive : ""}`}
                onClick={() => setSelectedVoice(v.id)}
                id={`voice-select-${v.id}`}
              >
                <div className={styles.voiceInfo}>
                  <div className={styles.voiceTitleRow}>
                    <span className={styles.voiceName}>
                      {v.gender === "female" ? "👩" : "👨"} {v.name}
                    </span>
                    <span className={styles.voiceAccent}>{v.accent}</span>
                    <span
                      style={{
                        fontSize: "0.72rem",
                        color: "var(--cyan)",
                        background: "rgba(0, 240, 255, 0.08)",
                        padding: "2px 6px",
                        borderRadius: "6px",
                      }}
                    >
                      {v.style}
                    </span>
                  </div>
                  <span className={styles.voiceDesc}>{v.description}</span>
                </div>
                {isActive && <span style={{ color: "var(--cyan)", fontWeight: "bold" }}>✓</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Metin Alanı */}
      <div className={styles.block}>
        <div className={styles.scriptMeta}>
          <label className={styles.label} style={{ margin: 0 }}>Metin / Senaryo</label>
          <span>
            {text.length} karakter · {text.trim() ? `~${estSeconds} sn` : "Süre hesaplanıyor"}
          </span>
        </div>
        <textarea
          rows={4}
          className="textarea"
          placeholder="Videoda seslendirilecek metni buraya yazın veya aşağıdaki hazır kancalardan birini seçin..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          id="voiceover-text-input"
        />

        {/* Hızlı Kancalar */}
        <div className={styles.presetChips}>
          {HOOK_PRESETS.map((p, i) => (
            <button
              key={i}
              type="button"
              className={styles.presetChip}
              onClick={() => setText(p.text)}
              title="Metin alanına yapıştır"
            >
              + {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Ayarlar: Konuşma Hızı ve Altyazı Eşitleme */}
      <div className={styles.block}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
          <label className={styles.label} style={{ margin: 0 }}>Konuşma Hızı</label>
          <span style={{ fontSize: "0.82rem", fontWeight: "bold", color: "var(--cyan)" }}>
            {speed.toFixed(2)}x
          </span>
        </div>
        <input
          type="range"
          min="0.75"
          max="1.4"
          step="0.05"
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className={styles.slider}
          id="voiceover-speed-slider"
        />
        <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
          {[0.9, 1.0, 1.15, 1.25].map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${speed === s ? "chip-active" : ""}`}
              onClick={() => setSpeed(s)}
              style={{ fontSize: "0.75rem", padding: "2px 8px" }}
            >
              {s}x {s === 1.0 ? "(Normal)" : s === 1.15 ? "(Shorts)" : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Altyazı Seçenekleri */}
      <div className={styles.block} style={{ background: "rgba(255,255,255,0.02)", padding: "10px", borderRadius: "10px", border: "1px solid var(--border)" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.85rem" }}>
          <input
            type="checkbox"
            checked={autoSubtitles}
            onChange={(e) => setAutoSubtitles(e.target.checked)}
            id="checkbox-auto-subtitles"
          />
          <strong>Otomatik Altyazı Oluştur & Senkronize Et</strong>
        </label>
        {autoSubtitles && (
          <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "0.76rem", color: "var(--text-faint)" }}>Stil:</span>
            <select
              value={subStyle}
              onChange={(e) => setSubStyle(e.target.value)}
              className="select"
              style={{ fontSize: "0.8rem", padding: "4px 8px" }}
              id="voiceover-sub-style"
            >
              <option value="karaoke">✨ Karaoke (Kelime kelime parlar)</option>
              <option value="word_pop">💥 Word Pop (Aktif kelime zıplar)</option>
              <option value="minimal">Minimalist (Şık ve sade)</option>
              <option value="boxed">Kutulu Arka Plan</option>
              <option value="classic">Klasik Sinematik</option>
            </select>
          </div>
        )}
      </div>

      {/* Önizleme Çalar */}
      {previewUrl && (
        <div className={styles.previewPlayer} id="voiceover-preview-player">
          <audio ref={previewAudioRef} src={mediaUrl(previewUrl)} controls style={{ width: "100%", height: "36px" }} />
          {previewDur && (
            <span style={{ fontSize: "0.76rem", color: "var(--cyan)", whiteSpace: "nowrap" }}>
              {previewDur} sn
            </span>
          )}
        </div>
      )}

      {/* Butonlar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handlePreview}
          disabled={previewLoading || !text.trim()}
          id="btn-voiceover-preview"
        >
          {previewLoading ? <span className="spinner" /> : "🎧 Sesi Dinle"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleApply}
          disabled={disabled || applying || !text.trim()}
          id="btn-voiceover-apply"
        >
          {applying ? <span className="spinner" /> : "⚡ Videoya Uygula"}
        </button>
      </div>
    </div>
  );
}
