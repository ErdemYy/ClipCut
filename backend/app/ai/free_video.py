"""Ücretsiz video fallback'i: görsel + yerel FFmpeg Ken Burns.

Veo çağrısı yapılmaz. Görsel kaynağı `FREE_IMAGE_PROVIDER` ile seçilir:

- `auto` (varsayılan): anahtarı tanımlıysa Pexels, sonra Pixabay; yoksa Picsum.
- `pexels` / `pixabay`: ücretsiz stok API'si (anahtar gerekir).
- `pollinations`: anahtarsız üretken görsel servisi; ücretsiz kotası yavaştır.
- `picsum`: anahtarsız, hızlı ama promptla eşleşmeyen stok fotoğraf.

Tüm sağlayıcılar başarısız olursa deterministik bir renk gradyanı üretilir. Görsel
seçilen en-boy oranına kırpılır ve yerel FFmpeg `zoompan` ile sessiz bir MP4'e
dönüştürülür. Seslendirme ve altyazı mevcut storyboard akışında ayrıca eklenir.
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import quote

import httpx

from .. import config
from ..ffmpeg import run_ffmpeg

log = logging.getLogger(__name__)

# catalog.FREE_VIDEO_MODEL ile aynı kimlik; döngüsel import'tan kaçınmak için burada.
FREE_VIDEO_MODEL = "free-ken-burns"
PICSUM_URL = "https://picsum.photos/seed/{seed}/{width}/{height}"
PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search"
PIXABAY_SEARCH_URL = "https://pixabay.com/api/"
POLLINATIONS_URL = "https://image.pollinations.ai/prompt/{prompt}"
USER_AGENT = "ClipCut/1.0 (free storyboard stills)"
MIN_IMAGE_BYTES = 4096
POLLINATIONS_INTERVAL = 46.0
POLLINATIONS_LOCK = threading.Lock()
POLLINATIONS_LAST = 0.0
SEARCH_STOPWORDS = {
    "a", "an", "and", "as", "at", "be", "by", "cinematic", "close", "closeup",
    "camera", "detail", "for", "from", "in", "into", "of", "on", "or", "over",
    "shot", "slow", "the", "to", "with", "without",
}


def target_size(aspect_ratio: str) -> tuple[int, int]:
    return {"9:16": (720, 1280), "1:1": (960, 960), "4:5": (864, 1080)}.get(aspect_ratio, (1280, 720))


def _seed(prompt: str) -> str:
    return hashlib.sha256(prompt.strip().encode("utf-8")).hexdigest()[:16]


def _colors(prompt: str) -> tuple[str, str]:
    digest = hashlib.sha256(prompt.strip().encode("utf-8")).digest()
    first = bytes(24 + (value % 40) for value in digest[:3])
    second = bytes(8 + (value % 24) for value in digest[3:6])
    return first.hex(), second.hex()


def _write_gradient(prompt: str, width: int, height: int, out_path: Path) -> None:
    c0, c1 = _colors(prompt)
    run_ffmpeg([
        "-f", "lavfi", "-i",
        f"gradients=s={width}x{height}:c0=0x{c0}:c1=0x{c1}:x0=0:y0=0:x1={width}:y1={height}:d=1",
        "-frames:v", "1", str(out_path),
    ], timeout=60)


def _search_query(prompt: str) -> str:
    words = re.findall(r"[A-Za-z0-9À-ÿ]+", prompt.lower())
    useful = [word for word in words if len(word) > 2 and word not in SEARCH_STOPWORDS]
    return " ".join(useful[:7]) or "cinematic landscape"


def _provider_order() -> list[str]:
    settings = config.get_settings()
    requested = (settings.free_image_provider or "auto").strip().lower()
    available = {
        "pexels": bool(settings.pexels_api_key.strip()),
        "pixabay": bool(settings.pixabay_api_key.strip()),
        "pollinations": True,
        "picsum": True,
    }
    if requested == "auto":
        order = [name for name in ("pexels", "pixabay") if available[name]]
        order.append("picsum")
        return order
    if requested not in available:
        log.warning("Bilinmeyen FREE_IMAGE_PROVIDER=%r; Picsum kullanılacak", requested)
        return ["picsum"]
    if requested in {"pexels", "pixabay"} and not available[requested]:
        log.warning("FREE_IMAGE_PROVIDER=%s için API anahtarı yok; Picsum kullanılacak", requested)
        return ["picsum"]
    return [requested] if requested == "picsum" else [requested, "picsum"]


def _safe_error(exc: Exception) -> str:
    """Sağlayıcı hata metninden URL ve sorgu anahtarlarını çıkarır."""
    text = re.sub(r"https?://[^\s)]+", "<url>", str(exc))
    text = re.sub(r"(?:key|token)=[^&\s)]+", "key=***", text, flags=re.IGNORECASE)
    return f"{type(exc).__name__}: {text}"


def _image_bytes(client: httpx.Client, url: str, *, timeout: float = 45,
                 headers: dict[str, str] | None = None) -> bytes:
    response = client.get(url, timeout=timeout, headers=headers)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    if not content_type.startswith("image/"):
        raise ValueError(f"Beklenmeyen içerik türü: {content_type or 'bilinmiyor'}")
    if len(response.content) < MIN_IMAGE_BYTES:
        raise ValueError("Görsel yanıtı çok küçük")
    return response.content


def _pexels_image(client: httpx.Client, prompt: str, key: str, width: int, height: int) -> bytes:
    response = client.get(
        PEXELS_SEARCH_URL,
        timeout=20,
        headers={"Authorization": key, "User-Agent": USER_AGENT},
        params={
            "query": _search_query(prompt),
            "per_page": 5,
            "orientation": "landscape" if width >= height else "portrait",
            "size": "large",
        },
    )
    response.raise_for_status()
    for photo in (response.json().get("photos") or []):
        source = photo.get("src") or {}
        url = source.get("large2x") or source.get("large") or source.get("original")
        if url:
            return _image_bytes(client, url, headers={"User-Agent": USER_AGENT})
    raise ValueError("Pexels sonucu bulunamadı")


def _pixabay_image(client: httpx.Client, prompt: str, key: str, width: int, height: int) -> bytes:
    response = client.get(
        PIXABAY_SEARCH_URL,
        timeout=20,
        headers={"User-Agent": USER_AGENT},
        params={
            "key": key,
            "q": _search_query(prompt),
            "image_type": "photo",
            "orientation": "horizontal" if width >= height else "vertical",
            "per_page": 5,
            "safesearch": "true",
        },
    )
    response.raise_for_status()
    for hit in (response.json().get("hits") or []):
        url = hit.get("largeImageURL") or hit.get("webformatURL") or hit.get("imageURL")
        if url:
            return _image_bytes(client, url, headers={"User-Agent": USER_AGENT})
    raise ValueError("Pixabay sonucu bulunamadı")


def _wait_for_pollinations(on_progress: Callable[[float, str], None], *, force: bool = False) -> None:
    settings = config.get_settings()
    if settings.pollinations_token.strip() and not force:
        return
    global POLLINATIONS_LAST
    with POLLINATIONS_LOCK:
        wait = POLLINATIONS_INTERVAL - (time.monotonic() - POLLINATIONS_LAST)
        if wait > 0:
            on_progress(0.12, f"Ücretsiz görsel kotası bekleniyor ({math.ceil(wait)} sn)")
            time.sleep(wait)
        POLLINATIONS_LAST = time.monotonic()


def _pollinations_image(client: httpx.Client, prompt: str, width: int, height: int,
                        on_progress: Callable[[float, str], None]) -> bytes:
    settings = config.get_settings()
    seed = int(_seed(prompt), 16) % 2_000_000_000
    url = (
        POLLINATIONS_URL.format(prompt=quote(prompt, safe=""))
        + f"?width={width}&height={height}&seed={seed}&nologo=true&model=flux"
    )
    headers = {"User-Agent": USER_AGENT}
    if settings.pollinations_token.strip():
        headers["Authorization"] = f"Bearer {settings.pollinations_token.strip()}"
    _wait_for_pollinations(on_progress)
    response = client.get(url, timeout=120, headers=headers)
    if response.status_code == 402 and not settings.pollinations_token.strip():
        _wait_for_pollinations(on_progress, force=True)
        response = client.get(url, timeout=120, headers=headers)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    if not content_type.startswith("image/"):
        raise ValueError(f"Beklenmeyen içerik türü: {content_type or 'bilinmiyor'}")
    if len(response.content) < MIN_IMAGE_BYTES:
        raise ValueError("Pollinations görseli çok küçük")
    return response.content


def _download_still(
    prompt: str, width: int, height: int, out_path: Path,
    on_progress: Callable[[float, str], None] | None = None,
) -> str:
    """Seçilen sağlayıcıdan görsel indirir; tümü başarısızsa gradyan yazar."""
    notify = on_progress or (lambda _value, _message: None)
    settings = config.get_settings()
    seed = _seed(prompt)
    errors: list[str] = []
    with httpx.Client(follow_redirects=True, timeout=45, headers={"User-Agent": USER_AGENT}) as client:
        for provider in _provider_order():
            try:
                notify(0.08, f"Ücretsiz görsel indiriliyor ({provider})")
                if provider == "pexels":
                    data = _pexels_image(client, prompt, settings.pexels_api_key.strip(), width, height)
                elif provider == "pixabay":
                    data = _pixabay_image(client, prompt, settings.pixabay_api_key.strip(), width, height)
                elif provider == "pollinations":
                    data = _pollinations_image(client, prompt, width, height, notify)
                else:
                    url = PICSUM_URL.format(seed=f"clipcut-{seed}", width=width, height=height)
                    data = _image_bytes(client, url)
                temporary = out_path.with_name(f"{out_path.name}.part")
                temporary.write_bytes(data)
                temporary.replace(out_path)
                return provider
            except Exception as exc:
                safe = _safe_error(exc)
                errors.append(f"{provider}: {safe}")
                log.warning("Ücretsiz görsel sağlayıcısı başarısız (%s): %s", provider, safe)
    log.warning("Tüm ücretsiz görsel sağlayıcıları başarısız; yerel gradyan kullanılacak: %s",
                "; ".join(errors))
    _write_gradient(prompt, width, height, out_path)
    return "local"


def _motion_filter(prompt: str, width: int, height: int, duration: int) -> str:
    frames = max(1, round(duration * 30))
    variant = int(_seed(prompt)[:2], 16) % 4
    center_x = "iw/2-(iw/zoom/2)"
    center_y = "ih/2-(ih/zoom/2)"
    if variant == 0:  # yavaş yakınlaşma
        zoom, x, y = f"1+0.08*on/{frames}", center_x, center_y
    elif variant == 1:  # yavaş uzaklaşma
        zoom, x, y = f"max(1,1.08-0.08*on/{frames})", center_x, center_y
    elif variant == 2:  # soldan sağa kaydırma
        zoom, x, y = "1.08", f"(iw-iw/zoom)*on/{frames}", center_y
    else:  # sağdan sola kaydırma
        zoom, x, y = "1.08", f"(iw-iw/zoom)*(1-on/{frames})", center_y
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"zoompan=z='{zoom}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps=30,"
        "format=yuv420p"
    )


def generate_video(
    prompt: str, aspect_ratio: str, duration: int, out_path: Path,
    on_progress: Callable[[float, str], None], image_path: Path | None = None,
) -> dict:
    """Sessiz bir Ken Burns sahnesi üretir; özel görsel verilirse sağlayıcıyı atlar."""
    width, height = target_size(aspect_ratio)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    on_progress(0.05, "Özel sahne görseli hazırlanıyor" if image_path else "Ücretsiz görsel hazırlanıyor")
    with tempfile.TemporaryDirectory(prefix="clipcut-free-", dir=out_path.parent) as temp:
        if image_path is not None:
            if not image_path.is_file():
                raise ValueError("Özel sahne görseli bulunamadı; yeniden yükleyin.")
            still = image_path
            source = "custom"
            on_progress(0.2, "Özel görsel kullanılıyor")
        else:
            still = Path(temp) / "still.jpg"
            source = _download_still(prompt, width, height, still, on_progress)
        on_progress(0.45, "Ken Burns hareketi uygulanıyor (yerel FFmpeg)")
        run_ffmpeg([
            "-loop", "1", "-i", str(still),
            "-vf", _motion_filter(prompt, width, height, duration),
            "-t", str(duration), "-r", "30",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_path),
        ], timeout=180)
    on_progress(0.95, "Ücretsiz sahne hazır")
    return {"provider": "free", "model": FREE_VIDEO_MODEL, "image_source": source}
