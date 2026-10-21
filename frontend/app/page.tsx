import Link from "next/link";
import styles from "./page.module.css";

const FEATURES = [
  { icon: "🎬", title: "Prompt'tan Video", text: "Google Veo ile tek cümleden sinematik klipler üretin. Dikey ya da yatay, saniyeler içinde." },
  { icon: "💬", title: "Profesyonel Altyazı", text: "Gemini konuşmayı kelime kelime yazıya döker; 17+ dile çevirip karaoke, pop veya klasik stillerle yakar." },
  { icon: "✨", title: "Prompt ile Edit", text: "“Sessiz yerleri at, dikey yap, lo-fi müzik koy” deyin; yapay zeka edit planını kurar, FFmpeg uygular." },
  { icon: "📐", title: "Akıllı Format", text: "9:16, 1:1, 4:5, 16:9 — bulanık arka plan, kırpma veya letterbox ile her platforma hazır." },
  { icon: "🎵", title: "Müzik & Ducking", text: "Konuşma başladığında otomatik kısılan fon müziği, whoosh / pop ses efektleri." },
  { icon: "🎨", title: "Renk & Geçiş", text: "Sinematik, vintage, siyah-beyaz renk paletleri; slide, wipe, zoom geçişleri ve animasyonlu başlıklar." },
];

const STEPS = [
  { n: "01", title: "Üret veya yükle", text: "Veo ile prompt'tan video üretin ya da kendi videonuzu sürükleyip bırakın." },
  { n: "02", title: "Altyazıla", text: "Dili seçin; transkripsiyon, çeviri ve zamanlama otomatik yapılır." },
  { n: "03", title: "Konuş, düzenlensin", text: "Ne istediğinizi yazın. Plan anında güncellenir, beğenmezseniz geri alın." },
  { n: "04", title: "Dışa aktar", text: "1080p MP4 ve SRT/VTT altyazı dosyalarını indirin." },
];

const WORDS = ["Yapay", "zeka", "ile", "video", "düzenle"];

export default function Home() {
  return (
    <main>
      <section className={styles.hero}>
        <div className={`container ${styles.heroGrid}`}>
          <div className={`${styles.heroCopy} fade-in`}>
            <span className="chip">
              <span className="dot dot-pulse" style={{ color: "var(--magenta)" }} /> Gemini · Veo · FFmpeg
            </span>
            <h1 className={styles.title}>
              Videonu <span className="gradient-text">anlat</span>,
              <br /> gerisini ClipCut halletsin.
            </h1>
            <p className={styles.lead}>
              Yapay zeka ile video üret, istediğin dilde profesyonel altyazı ekle ve tüm edit işlemlerini tek bir
              prompt ile otomatik yaptır.
            </p>
            <div className={styles.ctas}>
              <Link href="/create" className="btn btn-primary btn-lg" id="hero-create">
                Ücretsiz Başla →
              </Link>
              <Link href="/dashboard" className="btn btn-lg" id="hero-projects">
                Projelerim
              </Link>
            </div>
            <div className={styles.stats}>
              <div>
                <strong>17+</strong>
                <span>altyazı dili</span>
              </div>
              <div>
                <strong>13</strong>
                <span>edit operasyonu</span>
              </div>
              <div>
                <strong>1080p</strong>
                <span>dışa aktarma</span>
              </div>
            </div>
          </div>

          <div className={styles.showcase} aria-hidden>
            <div className={styles.glowOrb} />
            <div className={styles.phone}>
              <div className={styles.screen}>
                <div className={styles.scene} />
                <div className={styles.sceneTitle}>YENİ ÜRÜN</div>
                <div className={styles.caption}>
                  {WORDS.map((w, i) => (
                    <span key={w} style={{ animationDelay: `${i * 0.55}s` }}>
                      {w}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className={`${styles.floatCard} ${styles.promptCard} glass`}>
              <span className={styles.cardLabel}>Prompt</span>
              <p className={styles.typing}>Sessiz yerleri at, dikey yap, sarı altyazı ekle</p>
            </div>
            <div className={`${styles.floatCard} ${styles.opsCard} glass`}>
              <span className={styles.cardLabel}>Edit planı</span>
              <ul>
                <li>🔇 Sessizlik temizleme</li>
                <li>📐 9:16 · blur</li>
                <li>💬 Karaoke · #FFD400</li>
                <li>🎵 Lo-fi · ducking</li>
              </ul>
            </div>
            <div className={`${styles.floatCard} ${styles.langCard} glass`}>
              🇹🇷 → 🇬🇧 🇩🇪 🇪🇸 🇯🇵
            </div>
          </div>
        </div>
      </section>

      <section className={`container ${styles.section}`} id="ozellikler">
        <h2 className={styles.h2}>
          Bir video stüdyosu, <span className="gradient-text">tek bir kutuda</span>
        </h2>
        <p className={styles.sub}>Üretimden dışa aktarmaya kadar tüm akış yapay zeka destekli.</p>
        <div className={styles.features}>
          {FEATURES.map((f) => (
            <article key={f.title} className={`${styles.feature} glass`}>
              <span className={styles.featureIcon}>{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={`container ${styles.section}`} id="nasil-calisir">
        <h2 className={styles.h2}>Nasıl çalışır?</h2>
        <div className={styles.steps}>
          {STEPS.map((s) => (
            <div key={s.n} className={styles.step}>
              <span className={styles.stepNum}>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={`container ${styles.section}`}>
        <div className={`${styles.cta} glass`}>
          <h2>İlk videonu şimdi oluştur</h2>
          <p>API anahtarı olmadan demo modunda tüm akışı deneyebilirsin.</p>
          <Link href="/create" className="btn btn-primary btn-lg" id="footer-create">
            Hemen Dene
          </Link>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className="container">© 2026 ClipCut · Gemini &amp; Veo ile güçlendirildi</div>
      </footer>
    </main>
  );
}
