"use client";

import { useRef, useState } from "react";
import {
  API_URL,
  api,
  type OverlayOp,
  type Project,
} from "@/lib/api";
import { useReadList } from "@/lib/use-read-list";
import ReadListStatus from "./ReadListStatus";
import styles from "./editor-parts.module.css";

type Props = {
  project: Project;
  setProject: (p: Project) => void;
  notify: (t: string, e?: boolean) => void;
  disabled: boolean;
  time?: number;
  seek?: (t: number) => void;
};

const readStock = (_scope: string, signal: AbortSignal) => api.brollLibrary(signal);

export default function BrollPanel({ project, setProject, notify, disabled, time = 0, seek }: Props) {
  const stockRead = useReadList(project.id, readStock);
  const stock = stockRead.items;
  const [autoLoading, setAutoLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Yeni katman ayarları
  const [mode, setMode] = useState<"pip" | "fullscreen" | "sticker">("pip");
  const [position, setPosition] = useState<"top_right" | "top_left" | "bottom_right" | "bottom_left" | "center">("top_right");
  const [duration, setDuration] = useState<number>(2.5);
  const [animation, setAnimation] = useState<"pop" | "fade" | "slide" | "none">("pop");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const overlays = (project.plan?.operations?.filter((o) => o.type === "overlay") || []) as OverlayOp[];

  const savePlan = async (newOverlays: OverlayOp[]) => {
    const otherOps = (project.plan?.operations || []).filter((o) => o.type !== "overlay");
    const updatedPlan = { operations: [...otherOps, ...newOverlays] };
    const p = await api.setPlan(project.id, updatedPlan, project.render_revision);
    setProject(p);
  };

  const handleApplyAuto = async () => {
    if (disabled || autoLoading) return;
    setAutoLoading(true);
    try {
      const res = await api.applyAutoBroll(project.id, project.edit_revision);
      setProject(res.project);
      notify(res.summary);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setAutoLoading(false);
    }
  };

  const addOverlay = async (track: string, label: string) => {
    if (disabled) return;
    const start = Math.max(0, Math.round(time * 10) / 10);
    const newOv: OverlayOp = {
      type: "overlay",
      track,
      label,
      start,
      duration,
      mode,
      position,
      scale: mode === "fullscreen" ? 1.0 : mode === "sticker" ? 0.28 : 0.42,
      animation,
      border_radius: 14,
    };
    try {
      await savePlan([...overlays, newOv]);
      notify(`"${label}" B-Roll katmanı ${start}s anına eklendi!`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const removeOverlay = async (index: number) => {
    const updated = overlays.filter((_, i) => i !== index);
    try {
      await savePlan(updated);
      notify("Katman kaldırıldı.");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const handleGenerateAi = async () => {
    if (!aiPrompt.trim() || aiLoading) return;
    setAiLoading(true);
    try {
      const res = await api.generateBroll(project.id, aiPrompt.trim());
      await addOverlay(res.id, res.label);
      setAiPrompt("");
      notify("AI B-Roll görseli başarıyla üretildi ve eklendi!");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setAiLoading(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.uploadBroll(project.id, file);
      await addOverlay(res.id, res.label);
      notify("Görsel yüklendi ve katman eklendi!");
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.hero}>
        <span>🖼️</span>
        <h3>AI B-Roll & Görsel Katmanları</h3>
        <p>
          Konuşulan kelimelere göre videonun üzerine resim, grafik veya B-Roll yerleştirin.
        </p>
      </div>

      {/* Otomatik Tespit Butonu */}
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleApplyAuto}
        disabled={disabled || autoLoading}
        style={{ width: "100%", padding: "12px", fontSize: "0.92rem", justifyContent: "center" }}
        id="btn-auto-broll"
      >
        {autoLoading ? <span className="spinner" /> : "✨ Metinden Otomatik B-Roll Bul & Ekle"}
      </button>

      {/* Aktif Katmanlar Listesi */}
      <div className={styles.block}>
        <label className={styles.label}>
          <span>Aktif B-Roll Katmanları ({overlays.length})</span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>
            Zaman çizelgesinde sararak izleyin
          </span>
        </label>
        {overlays.length === 0 ? (
          <p style={{ fontSize: "0.8rem", color: "var(--text-faint)", margin: 0 }}>
            Henüz eklenmiş katman yok. Yukarıdaki otomatik butona tıklayın veya aşağıdan seçin.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "6px" }}>
            {overlays.map((ov, i) => (
              <div key={i} className={styles.overlayItem}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}
                  onClick={() => seek?.(ov.start)}
                  title="Bu zamana git"
                >
                  <span style={{ fontSize: "1.2rem" }}>🖼️</span>
                  <div>
                    <strong style={{ fontSize: "0.85rem", color: "#fff" }}>
                      {ov.label || "Katman " + (i + 1)}
                    </strong>
                    <div style={{ display: "flex", gap: "6px", marginTop: "2px" }}>
                      <span className="badge" style={{ fontSize: "0.7rem", padding: "1px 6px" }}>
                        ⏱ {ov.start}s – {(ov.start + ov.duration).toFixed(1)}s
                      </span>
                      <span className="badge" style={{ fontSize: "0.7rem", padding: "1px 6px", color: "var(--cyan)" }}>
                        {ov.mode.toUpperCase()}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => removeOverlay(i)}
                  style={{ color: "#ff6b6b", padding: "4px 8px" }}
                  title="Katmanı kaldır"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Katman Özelleştirme Ayarları */}
      <div className={styles.block} style={{ background: "rgba(255,255,255,0.02)", padding: "10px", borderRadius: "10px", border: "1px solid var(--border)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
          <div>
            <label className={styles.label} style={{ fontSize: "0.74rem", margin: "0 0 4px" }}>Görünüm Modu</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              className="select"
              style={{ fontSize: "0.78rem", padding: "4px 6px", width: "100%" }}
            >
              <option value="pip">PIP (Küçük Resim)</option>
              <option value="fullscreen">Tam Ekran</option>
              <option value="sticker">Çıkartma / İkon</option>
            </select>
          </div>
          <div>
            <label className={styles.label} style={{ fontSize: "0.74rem", margin: "0 0 4px" }}>Konum</label>
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value as typeof position)}
              className="select"
              style={{ fontSize: "0.78rem", padding: "4px 6px", width: "100%" }}
              disabled={mode === "fullscreen"}
            >
              <option value="top_right">Sağ Üst</option>
              <option value="top_left">Sol Üst</option>
              <option value="center">Merkez</option>
              <option value="bottom_right">Sağ Alt</option>
              <option value="bottom_left">Sol Alt</option>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
          <div>
            <label className={styles.label} style={{ fontSize: "0.74rem", margin: "0 0 4px" }}>Süre ({duration}s)</label>
            <input
              type="range"
              min="1.0"
              max="6.0"
              step="0.5"
              value={duration}
              onChange={(e) => setDuration(parseFloat(e.target.value))}
              className={styles.slider}
            />
          </div>
          <div>
            <label className={styles.label} style={{ fontSize: "0.74rem", margin: "0 0 4px" }}>Animasyon</label>
            <select
              value={animation}
              onChange={(e) => setAnimation(e.target.value as typeof animation)}
              className="select"
              style={{ fontSize: "0.78rem", padding: "4px 6px", width: "100%" }}
            >
              <option value="pop">Pop (Zıplama)</option>
              <option value="fade">Fade (Belirme)</option>
              <option value="slide">Slide (Kayma)</option>
              <option value="none">Animasyonsuz</option>
            </select>
          </div>
        </div>
      </div>

      {/* Hazır Stok B-Roll Kütüphanesi */}
      <div className={styles.block}>
        <ReadListStatus id="broll-list" label="Stok B-roll listesi" empty="Kullanılabilir stok B-roll görseli yok." state={stockRead} />
        <label className={styles.label}>
          <span>Stok B-Roll Kütüphanesi</span>
          <span style={{ fontSize: "0.75rem", color: "var(--cyan)" }}>
            Zamana ({time.toFixed(1)}s) Ekle
          </span>
        </label>
        <div className={styles.brollGrid}>
          {stock.map((item) => (
            <div
              key={item.id}
              className={styles.brollCard}
              onClick={() => addOverlay(`asset:broll:${item.id}`, item.label)}
              title={`Şu anki zamana (${time.toFixed(1)}s) ekle`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${API_URL}${item.url}`} alt={item.label} className={styles.brollCardBg} />
              <div className={styles.brollCardContent}>
                <span className={styles.brollCardTitle}>{item.icon} {item.label}</span>
                <span className={styles.brollCardCategory}>{item.category}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AI Görsel Üretimi */}
      <div className={styles.block}>
        <label className={styles.label}>
          <span>🎨 AI ile Özel B-Roll Üret</span>
        </label>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            type="text"
            className="input"
            placeholder="Örn: Geleceğin neon şehri veya altın kupa..."
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleGenerateAi()}
            style={{ fontSize: "0.82rem" }}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleGenerateAi}
            disabled={aiLoading || !aiPrompt.trim()}
            style={{ whiteSpace: "nowrap" }}
          >
            {aiLoading ? <span className="spinner" /> : "Üret"}
          </button>
        </div>
      </div>

      {/* Özel Dosya Yükleme */}
      <div className={styles.block}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: "none" }}
          onChange={handleUpload}
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{ width: "100%", justifyContent: "center", fontSize: "0.85rem" }}
        >
          {uploading ? <span className="spinner" /> : "📁 Kendi Görselini/Videonu Yükle"}
        </button>
      </div>
    </div>
  );
}
