"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Health } from "@/lib/api";
import styles from "./Navbar.module.css";

const LINKS = [
  { href: "/dashboard", label: "Projeler" },
  { href: "/create", label: "Yeni Video" },
];

export default function Navbar() {
  const pathname = usePathname();
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setOffline(true));
  }, []);

  const isEditor = pathname?.startsWith("/editor");

  return (
    <header className={`${styles.nav} ${isEditor ? styles.compact : ""}`}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand} id="nav-home">
          <span className={styles.logo} aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22">
              <path d="M9 7l16 9-16 9z" fill="white" />
              <path d="M5 12h6M5 20h6" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          Clip<span className="gradient-text">Cut</span>
        </Link>
        <nav className={styles.links}>
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              id={`nav-${l.href.slice(1)}`}
              className={`${styles.link} ${pathname?.startsWith(l.href) ? styles.active : ""}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className={styles.status}>
          {offline ? (
            <span className="badge badge-failed" title="Backend'e bağlanılamadı (http://localhost:8000)">
              <span className="dot" /> API kapalı
            </span>
          ) : health ? (
            <span
              className="badge badge-generating"
              title={health.mock ? "Test sağlayıcısı etkin: gerçek AI çağrısı yapılmaz. Gerçek üretim için GEMINI_API_KEY ayarlayın." : "Anahtarın tanımlı olması bağlantıyı doğrulamaz. Yeni Video sayfasındaki AI bağlantısı panelinden kontrol edin."}
            >
              <span className="dot" /> {health.mock ? "Test sağlayıcısı" : health.ai_key_configured === false ? "AI anahtarı yok" : "AI yapılandırıldı"}
            </span>
          ) : null}
          <Link href="/create" className="btn btn-primary btn-sm" id="nav-cta">
            + Oluştur
          </Link>
        </div>
      </div>
    </header>
  );
}
