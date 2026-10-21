import type { Metadata } from "next";
import { Suspense } from "react";
import Navbar from "@/components/Navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipCut — Yapay Zeka ile Video Üret, Altyazıla ve Düzenle",
  description:
    "ClipCut ile prompt'tan video üretin, istediğiniz dilde profesyonel altyazı ekleyin ve tek cümleyle otomatik video düzenleme yapın.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Suspense fallback={<div style={{ height: 66 }} />}>
          <Navbar />
        </Suspense>
        <Suspense fallback={<div className="loading-fallback"><span className="spinner" /></div>}>
          {children}
        </Suspense>
      </body>
    </html>
  );
}
