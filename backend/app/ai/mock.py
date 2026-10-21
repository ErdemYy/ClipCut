"""API anahtarı olmadan geliştirme/demo için deterministik mock AI servisleri."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

from ..edit.schema import (
    ColorGradeOp, CutRangeOp, EditPlan, FadeOp, MusicOp, ReframeOp, RemoveSilenceOp, SfxOp, SpeedOp,
    SubtitlesOp, TextOp, TransitionOp, TrimOp, VolumeOp,
)
from ..ffmpeg import run_ffmpeg
from ..subtitles.builder import distribute_words

SAMPLE = [
    ("Merhaba, ClipCut'a hoş geldiniz.", "Hello, welcome to ClipCut.", "Hallo, willkommen bei ClipCut."),
    ("Bugün size yapay zeka ile video düzenlemeyi göstereceğim.", "Today I'll show you how to edit videos with AI.", "Heute zeige ich euch, wie man Videos mit KI bearbeitet."),
    ("Sadece ne istediğinizi yazmanız yeterli.", "All you need to do is type what you want.", "Ihr müsst nur schreiben, was ihr wollt."),
    ("Altyazılar otomatik olarak oluşturulur.", "Subtitles are generated automatically.", "Untertitel werden automatisch erstellt."),
    ("İstediğiniz dile çevirebilirsiniz.", "You can translate them into any language.", "Ihr könnt sie in jede Sprache übersetzen."),
    ("Sessiz kısımlar kesilir, müzik eklenir.", "Silent parts are cut and music is added.", "Stille Teile werden geschnitten und Musik hinzugefügt."),
    ("Sonuç profesyonel görünen bir video.", "The result is a professional looking video.", "Das Ergebnis ist ein professionell aussehendes Video."),
    ("Hemen deneyin ve farkı görün.", "Try it now and see the difference.", "Probiert es jetzt aus und seht den Unterschied."),
]
_LOOKUP = {tr: {"en": en, "de": de} for tr, en, de in SAMPLE}


def transcript(duration: float) -> dict:
    segments = []
    t, i = 0.4, 0
    while t < duration - 0.8:
        text = SAMPLE[i % len(SAMPLE)][0]
        length = min(0.32 * len(text.split()) + 1.0, duration - t - 0.2)
        if length < 0.6:
            break
        words = [w.__dict__ for w in distribute_words(text, t, t + length)]
        segments.append({"id": i, "start": round(t, 3), "end": round(t + length, 3), "text": text, "words": words})
        t += length + 0.7
        i += 1
    return {"language": "tr", "segments": segments, "mock": True}


def translate_text(text: str, target: str) -> str:
    if target == "tr":
        return text
    hit = _LOOKUP.get(text, {}).get(target)
    return hit or f"[{target.upper()}] {text}"


# ------------------------------------------------------------ Kural tabanlı planlayıcı ----

COLORS = {
    "sarı": "#FFD400", "yellow": "#FFD400", "kırmızı": "#FF3B5C", "red": "#FF3B5C", "yeşil": "#3DDC84",
    "green": "#3DDC84", "mavi": "#3AA0FF", "blue": "#3AA0FF", "mor": "#A855F7", "purple": "#A855F7",
    "turuncu": "#FF8A00", "orange": "#FF8A00", "pembe": "#FF4FB8", "pink": "#FF4FB8", "turkuaz": "#22D3EE", "cyan": "#22D3EE",
}


def _has(text: str, *keys: str) -> bool:
    return any(k in text for k in keys)


def _replace(ops: list, new_op) -> list:
    return [o for o in ops if o.type != new_op.type] + [new_op]


def _remove(ops: list, op_type: str) -> list:
    return [o for o in ops if o.type != op_type]


def plan_edit(prompt: str, current: EditPlan, context: dict) -> tuple[EditPlan, str]:
    p = prompt.replace("İ", "i").lower()
    ops = list(current.operations)
    done: list[str] = []
    duration = float(context.get("duration", 0) or 0)
    out_duration = float(context.get("output_duration", duration) or duration)
    removing = _has(p, "kaldır", "sil ", "iptal", "remove", "kapat", "istemiyorum")

    if _has(p, "sıfırla", "baştan başla", "reset", "temizle"):
        return EditPlan(), "Plan sıfırlandı."

    if _has(p, "sessiz", "silence", "boşluk", "duraksama"):
        ops = _replace(ops, RemoveSilenceOp())
        done.append("sessiz kısımlar kesilecek")

    ratio = None
    if _has(p, "dikey", "9:16", "tiktok", "reels", "shorts", "story"):
        ratio = "9:16"
    elif _has(p, "kare", "1:1", "square"):
        ratio = "1:1"
    elif _has(p, "4:5"):
        ratio = "4:5"
    elif _has(p, "yatay", "16:9", "youtube", "landscape"):
        ratio = "16:9"
    if ratio:
        mode = "crop" if _has(p, "kırp", "crop", "doldur") else ("fit" if _has(p, "siyah bant", "letterbox", "fit") else "blur")
        ops = _replace(ops, ReframeOp(aspect_ratio=ratio, mode=mode))
        done.append(f"format {ratio} ({mode})")

    if _has(p, "altyazı", "subtitle", "caption"):
        if removing and _has(p, "altyazıyı kaldır", "altyazı istemiyorum", "remove subtitle", "altyazıyı kapat"):
            ops = _remove(ops, "subtitles")
            done.append("altyazı kaldırıldı")
        else:
            prev = current.first("subtitles")
            data = prev.model_dump() if prev else SubtitlesOp().model_dump()
            data["enabled"] = True
            if _has(p, "karaoke", "vurgu", "tiktok", "highlight"):
                data["style"] = "karaoke"
            if _has(p, "kelime kelime", "pop", "zıpla", "word"):
                data["style"] = "word_pop"
            if _has(p, "kutu", "box", "arka plan"):
                data["style"] = "boxed"
            if _has(p, "sade", "minimal"):
                data["style"] = "minimal"
            if _has(p, "klasik", "classic", "sinema altyazı", "netflix"):
                data["style"] = "classic"
            for name, hex_ in COLORS.items():
                if name in p:
                    data["highlight_color"] = hex_
                    break
            if _has(p, "büyük harf", "uppercase", "caps"):
                data["uppercase"] = True
            if _has(p, "büyük altyazı", "büyük yazı", "large"):
                data["size"] = "large"
            if _has(p, "küçük", "small"):
                data["size"] = "small"
            if _has(p, "üstte", "üste", "yukarı", "top"):
                data["position"] = "top"
            elif _has(p, "ortada", "ortaya", "middle", "center"):
                data["position"] = "middle"
            elif _has(p, "altta", "alta", "bottom"):
                data["position"] = "bottom"
            for font in ("Montserrat", "Poppins", "Bebas Neue", "Anton", "Inter"):
                if font.lower() in p:
                    data["font"] = font
            ops = _replace(ops, SubtitlesOp(**data))
            done.append(f"altyazı ({data['style']})")

    if _has(p, "müzik", "music", "şarkı", "fon"):
        if removing and _has(p, "müziği", "music"):
            ops = _remove(ops, "music")
            done.append("müzik kaldırıldı")
        else:
            track = "lofi_chill"
            if _has(p, "enerjik", "hareketli", "energetic", "upbeat", "coşkulu"):
                track = "upbeat_pulse"
            elif _has(p, "sakin", "ambient", "huzurlu", "calm"):
                track = "ambient_pad"
            elif _has(p, "epik", "epic", "gerilim", "dramatik"):
                track = "cinematic_rise"
            vol = 0.3 if _has(p, "yüksek müzik", "müzik yüksek", "loud music") else (0.1 if _has(p, "hafif", "düşük", "kısık", "soft") else 0.18)
            ops = _replace(ops, MusicOp(track=track, volume=vol, ducking=True))
            done.append(f"müzik: {track}")

    preset = None
    if _has(p, "siyah beyaz", "siyah-beyaz", "black and white", "b&w", "monokrom"):
        preset = "bw"
    elif _has(p, "sinematik", "cinematic", "film gibi"):
        preset = "cinematic"
    elif _has(p, "canlı renk", "renkli", "vibrant", "doygun"):
        preset = "vibrant"
    elif _has(p, "sıcak", "warm"):
        preset = "warm"
    elif _has(p, "soğuk", "cool"):
        preset = "cool"
    elif _has(p, "vintage", "retro", "nostalji", "eski film"):
        preset = "vintage"
    elif _has(p, "karanlık", "moody", "melankolik"):
        preset = "moody"
    elif _has(p, "parlak", "aydınlık", "bright"):
        preset = "bright"
    vignette = _has(p, "vinyet", "vignette")
    grain = _has(p, "gren", "grain")
    if preset or vignette or grain:
        prev = current.first("color_grade")
        data = prev.model_dump() if prev else ColorGradeOp().model_dump()
        if preset:
            data["preset"] = preset
        data["vignette"] = data["vignette"] or vignette
        data["grain"] = data["grain"] or grain
        ops = _replace(ops, ColorGradeOp(**data))
        done.append(f"renk: {data['preset']}")

    m = re.search(r"(\d+(?:[.,]\d+)?)\s*x\b|x\s*(\d+(?:[.,]\d+)?)", p)
    factor = None
    if m and _has(p, "hız", "speed", "kat"):
        factor = float((m.group(1) or m.group(2)).replace(",", "."))
    elif _has(p, "hızlandır", "speed up", "faster", "daha hızlı"):
        factor = 1.25
    elif _has(p, "yavaşlat", "slow", "ağır çekim"):
        factor = 0.75
    if factor:
        ops = _replace(ops, SpeedOp(factor=max(0.25, min(4.0, factor))))
        done.append(f"hız x{factor:g}")

    if _has(p, "geçiş", "transition"):
        style = "fade"
        for keys, s in ((("kayma", "kaydır", "slide"), "slideleft"), (("silme", "wipe"), "wipeleft"), (("zoom", "yakınlaş"), "zoomin"),
                        (("çember", "daire", "circle"), "circleopen"), (("siyah", "black"), "fadeblack"), (("dissolve", "erime"), "dissolve")):
            if _has(p, *keys):
                style = s
                break
        ops = _replace(ops, TransitionOp(style=style))
        done.append(f"geçiş: {style}")

    if _has(p, "fade", "karar", "açılış", "kapanış", "solma"):
        ops = _replace(ops, FadeOp(fade_in=0.8, fade_out=1.0))
        done.append("açılış/kapanış kararması")

    quoted = re.findall(r"[\"'“”‘’«»]([^\"'“”‘’«»]{1,120})[\"'“”‘’«»]", prompt)
    if quoted and _has(p, "başlık", "title", "yazı", "metin", "text", "ekle"):
        for q in quoted:
            at_end = _has(p, "sonda", "sona", "en son", "bitiş", "end")
            start = max(0.0, out_duration - 3.0) if at_end else 0.0
            ops.append(TextOp(text=q.strip(), start=start, duration=3.0, position="middle" if not at_end else "middle",
                              animation="pop" if _has(p, "pop", "zıpla") else ("typewriter" if _has(p, "daktilo", "typewriter") else "fade_up"),
                              background=_has(p, "kutulu", "arka planlı", "boxed")))
            done.append(f"metin: “{q.strip()}”")

    if _has(p, "sesi yükselt", "sesi artır", "louder", "sesi aç"):
        ops = _replace(ops, VolumeOp(gain=1.5))
        done.append("ses +50%")
    elif _has(p, "sesi azalt", "sesi kıs", "quieter"):
        ops = _replace(ops, VolumeOp(gain=0.7))
        done.append("ses -30%")
    if _has(p, "normalize", "sesi dengele", "ses seviyesini dengele"):
        prev = current.first("volume")
        ops = _replace(ops, VolumeOp(gain=prev.gain if prev else 1.0, normalize=True))
        done.append("ses normalize")

    if _has(p, "whoosh", "ses efekti", "sfx", "efekt sesi"):
        ops.append(SfxOp(track="whoosh", at=0.0))
        done.append("ses efekti: whoosh")

    rng = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:\.|'?(?:inci|ıncı|uncu|üncü|nci|ncı)?)?\s*(?:ile|ve|-|–)\s*(\d+(?:[.,]\d+)?)\s*\.?\s*(?:saniye|sn|s\b)", p)
    first_n = re.search(r"ilk\s+(\d+(?:[.,]\d+)?)\s*(?:saniye|sn)", p)
    last_n = re.search(r"son\s+(\d+(?:[.,]\d+)?)\s*(?:saniye|sn)", p)
    cut_words = ("kes", "sil", "çıkar", " at", "cut", "remove")
    if rng and _has(p, *cut_words):
        a, b = sorted(float(x.replace(",", ".")) for x in rng.groups())
        ops.append(CutRangeOp(start=a, end=b))
        done.append(f"{a:g}-{b:g} sn kesildi")
    elif first_n:
        n = float(first_n.group(1).replace(",", "."))
        if _has(p, *cut_words):
            ops.append(CutRangeOp(start=0, end=n))
            done.append(f"ilk {n:g} sn kesildi")
        else:
            ops = _replace(ops, TrimOp(start=0, end=n))
            done.append(f"yalnızca ilk {n:g} sn")
    elif last_n and duration:
        n = float(last_n.group(1).replace(",", "."))
        if _has(p, *cut_words):
            ops.append(CutRangeOp(start=max(0, duration - n), end=duration))
            done.append(f"son {n:g} sn kesildi")
        else:
            ops = _replace(ops, TrimOp(start=max(0, duration - n), end=None))
            done.append(f"yalnızca son {n:g} sn")

    if not done:
        return current, ("Komutu anlayamadım (mock planlayıcı). Örnek: “sessiz yerleri at, dikey yap, sarı karaoke altyazı ekle, "
                         "lofi müzik koy”. Gerçek Gemini planlayıcı için GEMINI_API_KEY ayarlayın.")
    return EditPlan(operations=ops), "Uygulandı: " + ", ".join(done) + "."


# ------------------------------------------------------------ Mock Veo ----

def generate_video(prompt: str, aspect_ratio: str, duration: int, out_path: Path, on_progress: Callable[[float, str], None]) -> None:
    import time

    w, h = (720, 1280) if aspect_ratio == "9:16" else (1280, 720)
    for i in range(4):
        on_progress(0.1 + i * 0.15, "Mock Veo: sahne kurgulanıyor")
        time.sleep(0.5)
    safe = prompt.replace("\\", "/").replace("{", "(").replace("}", ")")[:140]
    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Montserrat,{int(min(w, h) * 0.06)},&H00FFFFFF,&H00FFFFFF,&H50000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,5,60,60,0,1
Style: S,Inter,{int(min(w, h) * 0.032)},&H30FFFFFF,&H30FFFFFF,&H60000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,60,60,{int(h * 0.08)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:{duration:02d}.00,T,,0,0,0,,{{\\fad(600,600)\\t(0,{duration * 1000},\\fscx112\\fscy112)}}{safe}
Dialogue: 0,0:00:00.00,0:00:{duration:02d}.00,S,,0,0,0,,MOCK VEO · ClipCut
"""
    work = out_path.parent
    (work / "mock_title.ass").write_text(ass, encoding="utf-8")
    from ..config import get_settings
    import os

    fonts = os.path.relpath(get_settings().assets_dir / "fonts", work).replace("\\", "/")
    on_progress(0.7, "Mock Veo: render ediliyor")
    run_ffmpeg([
        "-f", "lavfi", "-i", f"gradients=s={w}x{h}:c0=0x1b0b3a:c1=0x6d28d9:c2=0xdb2777:c3=0x0ea5e9:nb_colors=4:speed=0.015:d={duration}:r=30",
        "-f", "lavfi", "-i", f"aevalsrc=0.06*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.3*t))+0.04*sin(2*PI*329.6*t):s=48000:d={duration}",
        "-vf", f"noise=alls=6:allf=t,subtitles=mock_title.ass:fontsdir={fonts},format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-shortest", str(out_path),
    ], cwd=work)
    on_progress(0.95, "Mock Veo: tamamlanıyor")
