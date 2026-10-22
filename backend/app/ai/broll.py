"""ClipCut AI B-Roll & Görsel Katmanı Modülü.

Konuşma metnini analiz ederek görselleştirilebilecek anahtar kavramları tespit eder,
doğru zaman damgalarında B-roll görselleri/katmanları önerir ve AI ile özel B-roll üretir.
"""
from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path
from typing import Any

from ..config import get_settings
from ..ffmpeg import run_ffmpeg

log = logging.getLogger("clipcut.broll")

# Hazır Stok B-Roll Kütüphanesi
BROLL_STOCK = [
    {
        "id": "tech",
        "label": "Yapay Zeka & Teknoloji",
        "category": "Teknoloji",
        "keywords": ["teknoloji", "yapay zeka", "ai", "robot", "algoritma", "yazılım", "bilgisayar", "dijital", "gelecek", "tech", "data"],
        "accent": "#00f0ff",
        "icon": "🤖",
        "prompt": "Futuristic glowing AI neural network and digital microchip, dark cyan neon, 3D render",
    },
    {
        "id": "growth",
        "label": "Büyüme & İlerleme",
        "category": "İş & Kariyer",
        "keywords": ["büyüme", "gelişme", "ilerleme", "hedef", "başarı", "zirve", "rekor", "grafik", "trend", "hızla", "fırsat", "growth"],
        "accent": "#22c55e",
        "icon": "📈",
        "prompt": "Glowing 3D upward trending green stock chart and financial success arrow on dark background",
    },
    {
        "id": "finance",
        "label": "Finans & Kazanç",
        "category": "Finans",
        "keywords": ["para", "finans", "kazanç", "gelir", "yatırım", "dolar", "kripto", "bitcoin", "satış", "fiyat", "zengin", "maliyet", "money"],
        "accent": "#eab308",
        "icon": "💰",
        "prompt": "Golden luxury coins and cryptocurrency hologram floating in air, studio lighting",
    },
    {
        "id": "ideas",
        "label": "Fikir & Yaratıcılık",
        "category": "Yaratıcılık",
        "keywords": ["fikir", "yaratıcı", "düşünce", "ilham", "çözüm", "strateji", "sır", "taktik", "yöntem", "keşfet", "öğren", "idea"],
        "accent": "#f59e0b",
        "icon": "💡",
        "prompt": "Glowing electric idea lightbulb with sparks of inspiration, dark moody background, high details",
    },
    {
        "id": "speed",
        "label": "Hız & Dinamizm",
        "category": "Aksiyon",
        "keywords": ["hız", "hızlı", "saniye", "anında", "dakika", "kolay", "pratik", "roket", "uçuş", "zaman", "performans", "fast", "speed"],
        "accent": "#ec4899",
        "icon": "🚀",
        "prompt": "Futuristic neon space rocket launching with light speed trails and glowing smoke, cinematic",
    },
    {
        "id": "code",
        "label": "Kod & Geliştirme",
        "category": "Yazılım",
        "keywords": ["kod", "kodlama", "programlama", "developer", "site", "uygulama", "web", "python", "javascript", "sistem", "kodlar"],
        "accent": "#8b5cf6",
        "icon": "💻",
        "prompt": "Modern dark mode IDE screen with colorful syntax code reflections, glassmorphism",
    },
    {
        "id": "nature",
        "label": "Doğa & Huzur",
        "category": "Atmosfer",
        "keywords": ["doğa", "huzur", "deniz", "sahil", "güneş", "manzara", "dünya", "seyahat", "tatil", "sakin", "nefes"],
        "accent": "#06b6d4",
        "icon": "🌊",
        "prompt": "Breathtaking ocean sunset with golden hour reflections and calm turquoise waves",
    },
    {
        "id": "celebrate",
        "label": "Kutlama & Viral",
        "category": "Sosyal Medya",
        "keywords": ["viral", "abone", "beğeni", "takip", "tiktok", "youtube", "harika", "muhteşem", "inanılmaz", "şaşırtıcı", "kutlama"],
        "accent": "#a855f7",
        "icon": "🎉",
        "prompt": "Explosion of golden confetti and vibrant holographic party lights, celebrate success",
    },
]


def list_stock_broll() -> list[dict[str, Any]]:
    return [
        {
            "id": b["id"],
            "label": b["label"],
            "category": b["category"],
            "icon": b["icon"],
            "accent": b["accent"],
            "url": f"/assets/broll/{b['id']}.jpg",
        }
        for b in BROLL_STOCK
    ]


def ensure_broll_stock(broll_dir: Path) -> None:
    """Stok B-Roll görsellerini prosedürel olarak oluşturur."""
    broll_dir.mkdir(parents=True, exist_ok=True)
    palette = {
        "tech": ("0x0a1128", "0x00f0ff", "0x7000ff", "AI & TECH"),
        "growth": ("0x052e16", "0x22c55e", "0x4ade80", "GROWTH"),
        "finance": ("0x2d1a04", "0xeab308", "0xfacc15", "FINANCE"),
        "ideas": ("0x2e1065", "0xf59e0b", "0xfbbf24", "INNOVATION"),
        "speed": ("0x3b0764", "0xec4899", "0xf43f5e", "HIGH SPEED"),
        "code": ("0x0f172a", "0x8b5cf6", "0x38bdf8", "CODE SYSTEM"),
        "nature": ("0x042f2e", "0x06b6d4", "0x14b8a6", "NATURE & SEA"),
        "celebrate": ("0x26072b", "0xa855f7", "0xd946ef", "VIRAL MOMENT"),
    }

    for b in BROLL_STOCK:
        out = broll_dir / f"{b['id']}.jpg"
        if out.exists() and out.stat().st_size > 5000:
            continue
        c1, c2, c3, title = palette.get(b["id"], ("0x111111", "0x00f0ff", "0xff007f", "B-ROLL"))
        log.info("B-Roll görseli üretiliyor: %s", b["id"])
        # FFmpeg lavfi gradient ve şekil kaynağı
        run_ffmpeg([
            "-f", "lavfi",
            "-i", f"color=c={c1}:s=1080x1080:d=1",
            "-filter_complex",
            f"[0:v]geq=r='128+110*sin(X/120)*cos(Y/120)':g='100+90*sin(X/160+Y/140)':b='180+70*cos(X/100)',"
            f"boxblur=18:1[bg];"
            f"[bg]drawbox=x=80:y=80:w=920:h=920:color={c2}@0.4:t=6[box];"
            f"[box]drawbox=x=120:y=120:w=840:h=840:color={c3}@0.2:t=fill[card];"
            f"[card]drawtext=text='{b['icon']}':fontsize=160:x=(w-text_w)/2:y=(h-text_h)/2-80:fontcolor=white,"
            f"drawtext=text='{title}':fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2+110:fontcolor=white:shadowcolor=black:shadowx=3:shadowy=3[out]",
            "-map", "[out]",
            "-vframes", "1",
            "-q:v", "3",
            str(out),
        ])


def suggest_broll_for_transcript(transcript: dict[str, Any] | None, video_duration: float = 10.0) -> list[dict[str, Any]]:
    """Transkriptteki kelimeleri ve zamanları tarayarak uygun B-Roll katmanları önerir."""
    if not transcript or not transcript.get("segments"):
        # Transkript yoksa video süresine göre 2 temel görsel öner
        mid = min(video_duration / 2, 2.5)
        return [
            {
                "type": "overlay",
                "track": f"asset:broll:{BROLL_STOCK[0]['id']}",
                "label": BROLL_STOCK[0]["label"],
                "start": round(mid, 2),
                "duration": 2.8,
                "mode": "pip",
                "position": "top_right",
                "scale": 0.42,
                "animation": "pop",
                "matched_keyword": "teknoloji",
            }
        ]

    suggestions: list[dict[str, Any]] = []
    used_times: list[tuple[float, float]] = []
    positions = ["top_right", "top_left", "bottom_right"]
    pos_idx = 0

    segments = transcript.get("segments", [])
    for seg in segments:
        text_lower = seg.get("text", "").lower()
        words = seg.get("words", [])

        for b in BROLL_STOCK:
            for kw in b["keywords"]:
                pattern = r"\b" + re.escape(kw) + r"\b"
                if re.search(pattern, text_lower):
                    # Kelimenin yaklaşık zamanını bul
                    w_start = seg.get("start", 0.0)
                    for w in words:
                        if kw in w.get("text", "").lower():
                            w_start = w.get("start", w_start)
                            break

                    start_time = max(0.2, round(w_start, 2))
                    dur = min(3.0, max(2.0, round(video_duration - start_time, 2)))
                    if dur < 1.0:
                        continue

                    # Çakışma kontrolü: Başka bir B-Roll ile en az 2 saniye aralık olsun
                    overlap = any(abs(start_time - ut[0]) < 2.5 for ut in used_times)
                    if not overlap:
                        used_times.append((start_time, start_time + dur))
                        suggestions.append({
                            "type": "overlay",
                            "track": f"asset:broll:{b['id']}",
                            "label": b["label"],
                            "start": start_time,
                            "duration": dur,
                            "mode": "pip",
                            "position": positions[pos_idx % len(positions)],
                            "scale": 0.42,
                            "animation": "pop",
                            "matched_keyword": kw,
                            "icon": b["icon"],
                        })
                        pos_idx += 1
                        break
            if len(suggestions) >= 4:
                break
        if len(suggestions) >= 4:
            break

    # Eşleşme çıkmadıysa ilk segmente uygun bir tane koy
    if not suggestions and segments:
        suggestions.append({
            "type": "overlay",
            "track": f"asset:broll:{BROLL_STOCK[0]['id']}",
            "label": BROLL_STOCK[0]["label"],
            "start": round(segments[0].get("start", 0.5), 2),
            "duration": 2.8,
            "mode": "pip",
            "position": "top_right",
            "scale": 0.42,
            "animation": "pop",
            "matched_keyword": "genel",
            "icon": BROLL_STOCK[0]["icon"],
        })

    return suggestions


def generate_broll_image(prompt: str, out_path: Path) -> Path:
    """Metin promptundan estetik AI / Prosedürel B-Roll görseli üretir."""
    clean = prompt.strip()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Renk seçimini prompt kelimelerinden türet
    h = abs(hash(clean)) % 360
    color1 = f"hsl({h}, 70%, 15%)"
    color2 = f"hsl({(h + 60) % 360}, 90%, 55%)"
    short_title = clean[:32].upper()

    run_ffmpeg([
        "-f", "lavfi",
        "-i", f"color=c=0x0b0f19:s=1080x1080:d=1",
        "-filter_complex",
        f"[0:v]geq=r='140+110*sin(X/140+Y/100)':g='120+100*cos(X/110-Y/140)':b='180+75*sin(X/80)',"
        f"boxblur=24:2[bg];"
        f"[bg]drawbox=x=60:y=60:w=960:h=960:color=white@0.15:t=4[border];"
        f"[border]drawbox=x=100:y=100:w=880:h=880:color=black@0.4:t=fill[glass];"
        f"[glass]drawtext=text='AI B-ROLL':fontsize=36:x=(w-text_w)/2:y=240:fontcolor=white@0.6,"
        f"drawtext=text='{short_title}':fontsize=52:x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:shadowcolor=black@0.8:shadowx=3:shadowy=3[out]",
        "-map", "[out]",
        "-vframes", "1",
        "-q:v", "2",
        str(out_path),
    ])

    return out_path
