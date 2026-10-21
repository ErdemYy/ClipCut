"""ClipCut Hazır Video & Edit Şablonları (Presets)."""
from __future__ import annotations

from typing import Any
from .schema import (
    ColorGradeOp,
    EditPlan,
    FadeOp,
    MusicOp,
    ReframeOp,
    RemoveSilenceOp,
    SubtitlesOp,
    TransitionOp,
    VolumeOp,
)

TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "tiktok_viral",
        "name": "TikTok & Reels Viral",
        "description": "Dikey format, konuşuldukça parlayan sarı karaoke altyazı, sessizlik temizleme, enerjik fon müziği ve kayma geçişleri.",
        "icon": "🔥",
        "tag": "Viral & Keşfet",
        "badge_color": "var(--amber)",
        "prompt": "Sessiz yerleri temizle, dikey 9:16 yap, sarı karaoke altyazı ekle, enerjik fon müziği koy, parçalar arasına kayma geçişi ekle",
        "plan": EditPlan(
            operations=[
                RemoveSilenceOp(threshold_db=-34.0, min_silence_ms=450, padding_ms=100),
                ReframeOp(aspect_ratio="9:16", mode="blur"),
                SubtitlesOp(enabled=True, style="karaoke", highlight_color="#FFD400", primary_color="#FFFFFF", size="medium", position="bottom"),
                MusicOp(track="upbeat_pulse", volume=0.18, ducking=True, fade_in=0.5, fade_out=1.5),
                TransitionOp(style="slideleft", duration=0.35),
            ]
        ).model_dump(),
    },
    {
        "id": "youtube_shorts_edu",
        "name": "YouTube Shorts Eğitici",
        "description": "Kelime kelime büyüyen büyük harfli mavi pop altyazı, duraksama temizleme, odaklı lofi müzik ve ses normalizasyonu.",
        "icon": "💡",
        "tag": "Eğitim & Bilgi",
        "badge_color": "var(--cyan)",
        "prompt": "Sessiz yerleri at, dikey yap, kelime kelime mavi pop altyazı ekle, büyük harf olsun, lofi müzik koy, konuşma sesini normalize et",
        "plan": EditPlan(
            operations=[
                RemoveSilenceOp(threshold_db=-35.0, min_silence_ms=500, padding_ms=120),
                ReframeOp(aspect_ratio="9:16", mode="blur"),
                SubtitlesOp(enabled=True, style="word_pop", highlight_color="#3AA0FF", primary_color="#FFFFFF", uppercase=True, size="medium", position="bottom"),
                MusicOp(track="lofi_chill", volume=0.15, ducking=True),
                VolumeOp(gain=1.1, normalize=True),
            ]
        ).model_dump(),
    },
    {
        "id": "ecommerce_ad",
        "name": "E-Ticaret & Ürün Tanıtımı",
        "description": "Canlı doygun renkler, şık vinyet, kutulu modern altyazı, ambient müzik ve giriş/çıkış kararma efektleri.",
        "icon": "🛍️",
        "tag": "Reklam & Satış",
        "badge_color": "var(--magenta)",
        "prompt": "Dikey 9:16 yap, canlı renk ve vinyet uygula, kutulu altyazı ekle, ambient fon müziği koy, açılış ve kapanışta karart",
        "plan": EditPlan(
            operations=[
                ReframeOp(aspect_ratio="9:16", mode="fit"),
                ColorGradeOp(preset="vibrant", vignette=True, contrast=1.1),
                SubtitlesOp(enabled=True, style="boxed", primary_color="#FFFFFF", outline_color="#000000", position="bottom"),
                MusicOp(track="ambient_pad", volume=0.2, ducking=True, fade_in=1.0, fade_out=1.5),
                FadeOp(fade_in=0.6, fade_out=0.8),
            ]
        ).model_dump(),
    },
    {
        "id": "cinematic_vlog",
        "name": "Sinematik Hikaye & Vlog",
        "description": "Geniş sinematik renk paleti, hafif film greni, epik yükselen müzik, klasik beyaz altyazı ve erime (dissolve) geçişleri.",
        "icon": "🎬",
        "tag": "Sinema & Atmosfer",
        "badge_color": "var(--violet)",
        "prompt": "Sinematik renk profili ve gren uygula, epik yükselen müzik koy, klasik sinema altyazısı ekle, erime geçişi yap",
        "plan": EditPlan(
            operations=[
                ColorGradeOp(preset="cinematic", grain=True, contrast=1.15),
                SubtitlesOp(enabled=True, style="classic", font="Montserrat", primary_color="#FFFFFF", size="small", position="bottom"),
                MusicOp(track="cinematic_rise", volume=0.22, ducking=True, fade_in=1.2, fade_out=2.0),
                TransitionOp(style="dissolve", duration=0.5),
            ]
        ).model_dump(),
    },
    {
        "id": "podcast_short",
        "name": "Podcast & Röportaj Kesiti",
        "description": "Hızlı akıcı konuşma için agresif sessizlik temizleme, kutulu yeşil altyazı, ses artırma ve normalize etme.",
        "icon": "🎙️",
        "tag": "Podcast & Sohbet",
        "badge_color": "var(--green)",
        "prompt": "Sessiz yerleri hızlıca at, dikey yap, sesi yükselt ve normalize et, kutulu yeşil altyazı koy, hafif lofi müzik ekle",
        "plan": EditPlan(
            operations=[
                RemoveSilenceOp(threshold_db=-32.0, min_silence_ms=380, padding_ms=90),
                ReframeOp(aspect_ratio="9:16", mode="blur"),
                VolumeOp(gain=1.35, normalize=True),
                SubtitlesOp(enabled=True, style="boxed", highlight_color="#3DDC84", outline_color="#18181B", position="bottom"),
                MusicOp(track="lofi_chill", volume=0.1, ducking=True),
            ]
        ).model_dump(),
    },
    {
        "id": "retro_vintage",
        "name": "Nostalji & Retro 90'lar",
        "description": "Sıcak vintage tonları, retro gren, köşe vinyeti, minimal sade altyazı ve sakin ambient tınılar.",
        "icon": "📼",
        "tag": "Retro & Estetik",
        "badge_color": "hsl(35 90% 60%)",
        "prompt": "Vintage retro renk ve gren uygula, vinyet ekle, minimal altyazı yap, sakin ambient fon müziği koy",
        "plan": EditPlan(
            operations=[
                ColorGradeOp(preset="vintage", grain=True, vignette=True),
                SubtitlesOp(enabled=True, style="minimal", position="bottom"),
                MusicOp(track="ambient_pad", volume=0.18, ducking=True),
            ]
        ).model_dump(),
    },
]


def get_template(template_id: str) -> dict[str, Any] | None:
    return next((t for t in TEMPLATES if t["id"] == template_id), None)
