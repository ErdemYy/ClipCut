"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AIConnectionReport } from "@/lib/api";
import styles from "./ai-connection.module.css";

const LABELS: Record<AIConnectionReport["status"], string> = {
  test: "Test sağlayıcısı", unchecked: "Kontrol edilmedi", missing_key: "Anahtar ayarlanmadı",
  checked: "Model bilgileri doğrulandı", partial: "Kısmen doğrulandı", error: "Doğrulanamadı",
};
const ROLES = { text: "Metin / planlama", transcription: "Transkripsiyon", video: "Video" };

export default function AIConnectionPanel() {
  const [report, setReport] = useState<AIConnectionReport | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  const run = useCallback(async (verify = false) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true); setError(null);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
      const result = await (verify ? api.checkAiConnection(signal) : api.aiConnection(signal));
      if (!controller.signal.aborted) setReport(result);
    } catch (e) {
      if (!controller.signal.aborted) {
        setReport(null);
        setError((e as Error).name === "TimeoutError" ? "Kontrol zaman aşımına uğradı; yeniden deneyin." : (e as Error).message);
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => { if (!disposed) return run(); });
    return () => { disposed = true; active.current?.abort(); active.current = null; };
  }, [run]);

  return <section id="ai-connection" className={styles.panel} aria-labelledby="ai-connection-title" aria-busy={pending}>
    <header className={styles.head}>
      <h2 id="ai-connection-title">AI bağlantısı</h2>
      <span role="status" aria-live="polite">{pending ? report?.can_check ? "Model bilgileri sorgulanıyor…" : "Yapılandırma yükleniyor…" : report ? LABELS[report.status] : "Durum alınamadı"}</span>
    </header>
    {error && <p role="alert">{error}</p>}
    {report && <>
      <p>{report.message}</p>
      <p>API anahtarı: <strong>{report.key_configured ? "Sunucuda tanımlı" : "Ayarlanmamış"}</strong>. Anahtar tarayıcıya gönderilmez.</p>
      <ul className={styles.models} aria-label="Yapılandırılmış modeller">
        {report.models.map((model) => <li key={model.role}>
          <strong>{ROLES[model.role]}</strong><code>{model.id}</code><span>{model.message}</span>
          {model.catalog_status === "deprecated" && <small>Yerel katalog bu modeli kullanımdan kaldırılma sürecinde işaretliyor.</small>}
          {model.catalog_status === "closed" && <small>Yerel katalog bu modeli kapatılmış olarak işaretliyor; güncel model yapılandırın.</small>}
        </li>)}
      </ul>
      {report.checked_at && <p>Son kontrol: <time dateTime={report.checked_at}>{new Date(report.checked_at).toLocaleString("tr-TR")}</time></p>}
      <p>{report.scope_note}</p>
      {!report.can_check && <p>Gerçek bağlantı için sunucudaki <code>backend/.env</code> dosyasında <code>GEMINI_API_KEY</code> ve <code>MOCK_AI=false</code> ayarlayıp backend sunucusunu yeniden başlatın. Video yükleme ve yerel düzenleme anahtarsız kullanılabilir.</p>}
    </>}
    <p>Kontrol düğmesi Google sağlayıcısına yalnızca anahtar doğrulamalı model bilgisi sorguları gönderir. Prompt, medya veya TTS gönderilmez; içerik üretimi yapılmaz.</p>
    {report?.can_check ? <button id="ai-connection-check" className="btn" disabled={pending} onClick={() => { void run(true); }}>
      {pending ? "Kontrol ediliyor…" : "Üretim yapmadan bağlantıyı kontrol et"}
    </button> : <button id="ai-connection-reload" className="btn" disabled={pending} onClick={() => { void run(); }}>
      {pending ? "Yükleniyor…" : "Yapılandırmayı yeniden yükle"}
    </button>}
  </section>;
}
