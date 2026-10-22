"""Varlık kütüphanesi: fontlar, müzik ve ses efektleri.

Müzik/SFX dosyaları ilk çalıştırmada FFmpeg ile prosedürel olarak üretilir (telifsiz).
`assets/music` veya `assets/sfx` klasörüne kendi .mp3/.wav dosyalarınızı da koyabilirsiniz.
"""
from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

from .config import get_settings
from .ffmpeg import run_ffmpeg

log = logging.getLogger("clipcut.assets")

AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov"}

FONTS = {
    "Montserrat-Variable.ttf": "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "Poppins-ExtraBold.ttf": "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-ExtraBold.ttf",
    "BebasNeue-Regular.ttf": "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf",
    "Anton-Regular.ttf": "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf",
    "Inter-Variable.ttf": "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf",
}
FONT_FAMILIES = ["Montserrat", "Poppins", "Bebas Neue", "Anton", "Inter"]

_KICK = "0.55*sin(2*PI*52*t*(1+2*exp(-30*mod(t,{b}))))*exp(-9*mod(t,{b}))"
_HAT = "0.035*(random(0)*2-1)*exp(-70*mod(t+{h},{b}))"

MUSIC = {
    "lofi_chill": {
        "label": "Lo-fi Chill", "mood": "sakin, rahat",
        "expr": "+".join([
            _KICK.format(b=0.8), _HAT.format(h=0.4, b=0.8),
            "0.07*sin(2*PI*if(lt(mod(t,6.4),3.2),220,196)*t)*(0.7+0.3*sin(2*PI*0.4*t))",
            "0.05*sin(2*PI*if(lt(mod(t,6.4),3.2),277.18,246.94)*t)",
            "0.045*sin(2*PI*if(lt(mod(t,6.4),3.2),329.63,293.66)*t)",
            "0.08*sin(2*PI*if(lt(mod(t,6.4),3.2),55,49)*t)",
        ]),
        "post": "lowpass=f=3200,aecho=0.6:0.5:60:0.25",
    },
    "upbeat_pulse": {
        "label": "Upbeat Pulse", "mood": "enerjik, hareketli",
        "expr": "+".join([
            _KICK.format(b=0.5), _HAT.format(h=0.25, b=0.5),
            "0.09*sin(2*PI*if(lt(mod(t,4),2),110,98)*t)*(0.5+0.5*sin(2*PI*4*t))",
            "0.05*sin(2*PI*(440+220*lt(mod(t,0.5),0.25))*t)*exp(-6*mod(t,0.25))",
            "0.04*sin(2*PI*if(lt(mod(t,4),2),329.63,392)*t)",
        ]),
        "post": "acompressor=threshold=0.3:ratio=3",
    },
    "ambient_pad": {
        "label": "Ambient Pad", "mood": "huzurlu, atmosferik",
        "expr": "+".join([
            "0.09*sin(2*PI*174.6*t)*(0.6+0.4*sin(2*PI*0.12*t))",
            "0.07*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.17*t))",
            "0.06*sin(2*PI*261.6*t)*(0.6+0.4*sin(2*PI*0.09*t))",
            "0.04*sin(2*PI*349.2*t)*(0.5+0.5*sin(2*PI*0.21*t))",
        ]),
        "post": "aecho=0.8:0.7:400|700:0.3|0.2,lowpass=f=2500",
    },
    "cinematic_rise": {
        "label": "Cinematic Rise", "mood": "epik, dramatik",
        "expr": "+".join([
            "0.12*sin(2*PI*41.2*t)",
            "0.07*sin(2*PI*82.4*t)*(0.5+0.5*sin(2*PI*0.25*t))",
            "0.05*sin(2*PI*(164.8+mod(t,8)*6)*t)*(mod(t,8)/8)",
            _KICK.format(b=2.0),
        ]),
        "post": "aecho=0.8:0.8:250|500:0.35|0.25",
    },
}

SFX = {
    "whoosh": {"label": "Whoosh", "src": "anoisesrc=d=0.7:c=pink:a=0.6", "post": "highpass=f=400,lowpass=f=6000,afade=t=in:d=0.35,afade=t=out:st=0.35:d=0.35"},
    "pop": {"label": "Pop", "src": "aevalsrc=0.7*sin(2*PI*(900-600*t)*t)*exp(-25*t):d=0.25", "post": "anull"},
    "ding": {"label": "Ding", "src": "aevalsrc=0.4*sin(2*PI*1318.5*t)*exp(-4*t)+0.25*sin(2*PI*1975.5*t)*exp(-5*t):d=1.2", "post": "anull"},
    "riser": {"label": "Riser", "src": "aevalsrc=0.25*sin(2*PI*(200+900*t*t/4)*t)*(t/2):d=2", "post": "aecho=0.6:0.5:80:0.3"},
}


def music_dir() -> Path:
    return get_settings().assets_dir / "music"


def sfx_dir() -> Path:
    return get_settings().assets_dir / "sfx"


def broll_dir() -> Path:
    return get_settings().assets_dir / "broll"


def fonts_dir() -> Path:
    return get_settings().assets_dir / "fonts"


def ensure_fonts() -> None:
    d = fonts_dir()
    d.mkdir(parents=True, exist_ok=True)
    for name, url in FONTS.items():
        target = d / name
        if target.exists() and target.stat().st_size > 10_000:
            continue
        try:
            log.info("Font indiriliyor: %s", name)
            urllib.request.urlretrieve(url, target)
        except Exception as exc:  # çevrimdışı olabilir; libass sistem fontuna düşer
            log.warning("Font indirilemedi (%s): %s", name, exc)


def ensure_audio_library() -> None:
    md, sd = music_dir(), sfx_dir()
    md.mkdir(parents=True, exist_ok=True)
    sd.mkdir(parents=True, exist_ok=True)
    for key, spec in MUSIC.items():
        out = md / f"{key}.mp3"
        if out.exists():
            continue
        log.info("Müzik üretiliyor: %s", key)
        run_ffmpeg(["-f", "lavfi", "-i", f"aevalsrc='{spec['expr']}':s=44100:d=32", "-af",
                    f"{spec['post']},afade=t=in:d=0.5,loudnorm=I=-18:TP=-2,aformat=channel_layouts=stereo", "-b:a", "160k", str(out)])
    for key, spec in SFX.items():
        out = sd / f"{key}.mp3"
        if out.exists():
            continue
        run_ffmpeg(["-f", "lavfi", "-i", spec["src"], "-af", f"{spec['post']},aformat=channel_layouts=stereo", "-b:a", "160k", str(out)])


def ensure_assets() -> None:
    ensure_fonts()
    ensure_audio_library()
    try:
        from .ai import broll
        broll.ensure_broll_stock(broll_dir())
    except Exception as exc:
        log.warning("B-Roll stok görselleri üretilemedi: %s", exc)


def list_library(kind: str) -> list[dict]:
    d = music_dir() if kind == "music" else sfx_dir()
    meta = MUSIC if kind == "music" else SFX
    items = []
    for f in sorted(d.glob("*")):
        if f.suffix.lower() in AUDIO_EXT:
            info = meta.get(f.stem, {})
            items.append({
                "id": f.stem, "label": info.get("label", f.stem.replace("_", " ").title()), "mood": info.get("mood", ""),
                "url": f"/assets/{kind}/{f.name}",
            })
    return items


def resolve_track(track: str, project_dir: Path | None) -> Path | None:
    """Parça id'sini dosya yoluna çevirir: 'lofi_chill', 'sfx:pop' veya 'project:benim.mp3'."""
    if track.startswith("project:") and project_dir:
        p = (project_dir / "audio" / Path(track.split(":", 1)[1]).name)
        return p if p.exists() else None
    name = track.split(":", 1)[-1]
    for d in (music_dir(), sfx_dir()):
        for f in d.glob(f"{Path(name).stem}.*"):
            if f.suffix.lower() in AUDIO_EXT:
                return f
    return None


def resolve_overlay(track: str, project_dir: Path | None) -> Path | None:
    """Overlay / B-Roll yolunu çözer: 'asset:broll:tech', 'project:broll/xyz.png' veya yerel dosya."""
    if track.startswith("asset:broll:"):
        b_id = track.split(":")[-1]
        target = broll_dir() / f"{b_id}.jpg"
        if target.exists():
            return target
    if track.startswith("project:") and project_dir:
        rel = track.split(":", 1)[1].lstrip("/\\")
        for cand in (project_dir / rel, project_dir / "broll" / Path(rel).name, project_dir / Path(rel).name):
            if cand.exists():
                return cand
    p = Path(track)
    if p.is_file():
        return p
    if project_dir:
        for cand in (project_dir / p.name, project_dir / "broll" / p.name):
            if cand.exists():
                return cand
    for f in broll_dir().glob(f"{p.stem}.*"):
        if f.suffix.lower() in IMAGE_EXT:
            return f
    return None

