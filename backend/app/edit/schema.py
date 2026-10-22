"""ClipCut Edit DSL.

AI hiçbir zaman doğrudan FFmpeg komutu üretmez; yalnızca bu şemaya uyan bir JSON planı üretir.
Plan, `renderer.py` tarafından deterministik olarak FFmpeg filtre grafiğine çevrilir.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

HEX_COLOR = r"^#[0-9A-Fa-f]{6}$"

AspectRatio = Literal["original", "9:16", "1:1", "16:9", "4:5"]
Position = Literal["top", "middle", "bottom"]
Size = Literal["small", "medium", "large"]


class _Op(BaseModel):
    model_config = ConfigDict(extra="ignore")


class TrimOp(_Op):
    """Videonun yalnızca [start, end] aralığını tutar (saniye, kaynak zamanı)."""
    type: Literal["trim"] = "trim"
    start: float = Field(0.0, ge=0)
    end: Optional[float] = Field(None, ge=0)


class CutRangeOp(_Op):
    """[start, end] aralığını videodan çıkarır (saniye, kaynak zamanı)."""
    type: Literal["cut_range"] = "cut_range"
    start: float = Field(..., ge=0)
    end: float = Field(..., ge=0)


class RemoveSilenceOp(_Op):
    type: Literal["remove_silence"] = "remove_silence"
    threshold_db: float = Field(-35.0, ge=-80, le=-5)
    min_silence_ms: int = Field(500, ge=150, le=5000)
    padding_ms: int = Field(120, ge=0, le=1000)


class ReframeOp(_Op):
    type: Literal["reframe"] = "reframe"
    aspect_ratio: AspectRatio = "9:16"
    mode: Literal["crop", "blur", "fit"] = "blur"


class SpeedOp(_Op):
    type: Literal["speed"] = "speed"
    factor: float = Field(1.0, ge=0.25, le=4.0)


ColorPreset = Literal["none", "cinematic", "vibrant", "warm", "cool", "bw", "vintage", "moody", "bright"]


class ColorGradeOp(_Op):
    type: Literal["color_grade"] = "color_grade"
    preset: ColorPreset = "none"
    brightness: float = Field(0.0, ge=-0.5, le=0.5)
    contrast: float = Field(1.0, ge=0.3, le=2.5)
    saturation: float = Field(1.0, ge=0.0, le=3.0)
    gamma: float = Field(1.0, ge=0.3, le=3.0)
    vignette: bool = False
    grain: bool = False


SubtitleStyle = Literal["classic", "karaoke", "word_pop", "boxed", "minimal"]


class SubtitlesOp(_Op):
    type: Literal["subtitles"] = "subtitles"
    enabled: bool = True
    style: SubtitleStyle = "karaoke"
    font: str = "Montserrat"
    size: Size = "medium"
    primary_color: str = Field("#FFFFFF", pattern=HEX_COLOR)
    highlight_color: str = Field("#FFD400", pattern=HEX_COLOR)
    outline_color: str = Field("#000000", pattern=HEX_COLOR)
    position: Position = "bottom"
    uppercase: bool = False
    max_words_per_line: int = Field(0, ge=0, le=12, description="0 = stile göre otomatik")


class MusicOp(_Op):
    type: Literal["music"] = "music"
    track: str
    volume: float = Field(0.18, ge=0.0, le=1.0)
    ducking: bool = True
    fade_in: float = Field(1.0, ge=0, le=10)
    fade_out: float = Field(2.0, ge=0, le=10)


class SfxOp(_Op):
    type: Literal["sfx"] = "sfx"
    track: str
    at: float = Field(0.0, ge=0, description="Çıktı zaman çizelgesinde saniye")
    volume: float = Field(0.8, ge=0.0, le=2.0)


class VolumeOp(_Op):
    type: Literal["volume"] = "volume"
    gain: float = Field(1.0, ge=0.0, le=4.0)
    normalize: bool = False


TransitionStyle = Literal[
    "fade", "dissolve", "fadeblack", "wipeleft", "wiperight", "slideleft", "slideright",
    "circleopen", "smoothleft", "zoomin",
]


class TransitionOp(_Op):
    """Kesimlerle oluşan parçalar arasına geçiş efekti uygular."""
    type: Literal["transition"] = "transition"
    style: TransitionStyle = "fade"
    duration: float = Field(0.4, ge=0.1, le=2.0)


class FadeOp(_Op):
    type: Literal["fade"] = "fade"
    fade_in: float = Field(0.0, ge=0, le=5)
    fade_out: float = Field(0.0, ge=0, le=5)


class TextOp(_Op):
    """Başlık veya metin katmanı (çıktı zaman çizelgesinde)."""
    type: Literal["text"] = "text"
    text: str = Field(..., min_length=1, max_length=200)
    start: float = Field(0.0, ge=0)
    duration: float = Field(3.0, gt=0, le=600)
    position: Position = "middle"
    animation: Literal["none", "fade", "fade_up", "pop", "typewriter"] = "fade_up"
    font: str = "Montserrat"
    color: str = Field("#FFFFFF", pattern=HEX_COLOR)
    size: Size = "large"
    background: bool = False


OverlayMode = Literal["pip", "fullscreen", "sticker"]
OverlayPosition = Literal["top_right", "top_left", "bottom_right", "bottom_left", "center"]
OverlayAnimation = Literal["pop", "fade", "slide", "none"]


class OverlayOp(_Op):
    """Görsel / Video / B-Roll katmanı (çıktı zaman çizelgesinde)."""
    type: Literal["overlay"] = "overlay"
    track: str = Field(..., min_length=1)
    label: Optional[str] = None
    start: float = Field(0.0, ge=0)
    duration: float = Field(3.0, gt=0, le=600)
    mode: OverlayMode = "pip"
    position: OverlayPosition = "top_right"
    scale: float = Field(0.42, ge=0.15, le=1.0)
    animation: OverlayAnimation = "pop"
    border_radius: int = Field(16, ge=0, le=60)


Operation = Annotated[
    Union[
        TrimOp, CutRangeOp, RemoveSilenceOp, ReframeOp, SpeedOp, ColorGradeOp, SubtitlesOp,
        MusicOp, SfxOp, VolumeOp, TransitionOp, FadeOp, TextOp, OverlayOp,
    ],
    Field(discriminator="type"),
]

SINGLETON_OPS = {"trim", "remove_silence", "reframe", "speed", "color_grade", "subtitles", "music", "volume", "transition", "fade"}


class EditPlan(BaseModel):
    model_config = ConfigDict(extra="ignore")
    operations: list[Operation] = Field(default_factory=list)

    @field_validator("operations")
    @classmethod
    def _dedupe_singletons(cls, ops: list) -> list:
        """Tekil operasyonlardan yalnızca sonuncusunu tutar (sırayı korur)."""
        last_index: dict[str, int] = {}
        for i, op in enumerate(ops):
            if op.type in SINGLETON_OPS:
                last_index[op.type] = i
        return [op for i, op in enumerate(ops) if op.type not in SINGLETON_OPS or last_index[op.type] == i]

    def first(self, op_type: str):
        return next((op for op in self.operations if op.type == op_type), None)

    def all(self, op_type: str) -> list:
        return [op for op in self.operations if op.type == op_type]


def dsl_reference() -> str:
    """Planlayıcı modeline verilen insan-okunur DSL referansı."""
    return """
operations listesi; her eleman bir "type" alanına sahip nesnedir:
- trim {start, end|null}: yalnızca bu aralığı tut (kaynak saniyesi)
- cut_range {start, end}: bu aralığı çıkar (kaynak saniyesi). Birden fazla olabilir.
- remove_silence {threshold_db=-35, min_silence_ms=500, padding_ms=120}: sessiz yerleri at
- reframe {aspect_ratio: "original"|"9:16"|"1:1"|"16:9"|"4:5", mode: "crop"|"blur"|"fit"}
- speed {factor: 0.25-4}
- color_grade {preset: "none"|"cinematic"|"vibrant"|"warm"|"cool"|"bw"|"vintage"|"moody"|"bright", brightness -0.5..0.5, contrast 0.3..2.5, saturation 0..3, gamma 0.3..3, vignette bool, grain bool}
- subtitles {enabled, style: "classic"|"karaoke"|"word_pop"|"boxed"|"minimal", font, size: "small"|"medium"|"large", primary_color "#RRGGBB", highlight_color, outline_color, position: "top"|"middle"|"bottom", uppercase bool, max_words_per_line (0=otomatik)}
- music {track (kütüphaneden id), volume 0..1 (öneri 0.12-0.25), ducking bool, fade_in, fade_out}
- sfx {track, at (çıktı saniyesi), volume}: birden fazla olabilir
- volume {gain 0..4, normalize bool}: konuşma sesi
- transition {style: "fade"|"dissolve"|"fadeblack"|"wipeleft"|"wiperight"|"slideleft"|"slideright"|"circleopen"|"smoothleft"|"zoomin", duration 0.1..2}: kesilen parçalar arası geçiş
- fade {fade_in, fade_out}: video başı/sonu karartma (saniye)
- text {text, start (çıktı saniyesi), duration, position, animation: "none"|"fade"|"fade_up"|"pop"|"typewriter", font, color, size, background bool}: başlık/metin. Birden fazla olabilir.
Tekil tipler (text, sfx, cut_range dışındakiler) planda en fazla bir kez bulunur.
""".strip()
