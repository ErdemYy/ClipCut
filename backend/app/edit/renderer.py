"""Edit planını FFmpeg filter_complex'e çeviren deterministik render motoru."""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from ..ffmpeg import MediaInfo, run_ffmpeg_with_progress
from ..subtitles.builder import build_ass, map_words, transcript_words
from .schema import ColorGradeOp, EditPlan
from .timeline import Timeline

ASPECT_SIZES = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080), "4:5": (1080, 1350)}
MAX_SIDE = 1920
FPS = 30

COLOR_PRESETS = {
    "none": [],
    "cinematic": ["eq=contrast=1.12:saturation=0.88", "colorbalance=rs=-0.05:bs=0.08:rh=0.08:bh=-0.06"],
    "vibrant": ["eq=saturation=1.45:contrast=1.06"],
    "warm": ["colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.05", "eq=saturation=1.1"],
    "cool": ["colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06"],
    "bw": ["hue=s=0", "eq=contrast=1.15"],
    "vintage": ["curves=preset=vintage", "eq=saturation=0.85"],
    "moody": ["eq=contrast=1.2:brightness=-0.04:saturation=0.75", "colorbalance=bs=0.05:bm=0.03"],
    "bright": ["eq=brightness=0.05:contrast=1.05:saturation=1.15:gamma=1.05"],
}

TrackResolver = Callable[[str], Optional[Path]]


@dataclass
class RenderRequest:
    source: Path
    info: MediaInfo
    plan: EditPlan
    timeline: Timeline
    transcript: Optional[dict]
    work_dir: Path
    output: Path
    fonts_dir: Path
    resolve_track: TrackResolver


def even(n: float) -> int:
    return max(2, int(round(n / 2)) * 2)


def output_size(info: MediaInfo, plan: EditPlan) -> tuple[int, int]:
    reframe = plan.first("reframe")
    if reframe and reframe.aspect_ratio != "original":
        return ASPECT_SIZES[reframe.aspect_ratio]
    w, h = info.width or 1280, info.height or 720
    scale = min(1.0, MAX_SIDE / max(w, h))
    return even(w * scale), even(h * scale)


def atempo_chain(factor: float) -> list[str]:
    parts = []
    f = factor
    while f > 2.0:
        parts.append("atempo=2.0")
        f /= 2.0
    while f < 0.5:
        parts.append("atempo=0.5")
        f /= 0.5
    parts.append(f"atempo={f:.4f}")
    return parts


def color_filters(op: ColorGradeOp | None) -> list[str]:
    if not op:
        return []
    filters = list(COLOR_PRESETS.get(op.preset, []))
    if (op.brightness, op.contrast, op.saturation, op.gamma) != (0.0, 1.0, 1.0, 1.0):
        filters.append(f"eq=brightness={op.brightness:.3f}:contrast={op.contrast:.3f}:saturation={op.saturation:.3f}:gamma={op.gamma:.3f}")
    if op.vignette:
        filters.append("vignette=angle=PI/5")
    if op.grain:
        filters.append("noise=alls=9:allf=t")
    return filters


def _rel(path: Path, start: Path) -> str:
    try:
        return os.path.relpath(path, start).replace("\\", "/")
    except ValueError:  # farklı sürücü
        target = start / path.name
        if not target.exists():
            shutil.copytree(path, target) if path.is_dir() else shutil.copy2(path, target)
        return path.name


def build_command(req: RenderRequest) -> tuple[list[str], float]:
    plan, tl, info = req.plan, req.timeline, req.info
    W, H = output_size(info, plan)
    T = tl.output_duration
    inputs: list[str] = ["-i", str(req.source)]
    next_input = 1

    audio_label = "0:a"
    if not info.has_audio:
        inputs += ["-f", "lavfi", "-t", f"{info.duration:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        audio_label = f"{next_input}:a"
        next_input += 1

    f: list[str] = []
    n = len(tl.segments)

    # 1) Kaynak normalizasyonu + parçalara bölme
    f.append(f"[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,fps={FPS},format=yuv420p,setsar=1,split={n}" + "".join(f"[vs{i}]" for i in range(n)))
    f.append(f"[{audio_label}]aresample=48000,aformat=channel_layouts=stereo,asplit={n}" + "".join(f"[as{i}]" for i in range(n)))
    for i, (s, e) in enumerate(tl.segments):
        f.append(f"[vs{i}]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,settb=AVTB,fps={FPS}[v{i}]")
        f.append(f"[as{i}]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]")

    # 2) Birleştirme (geçişli veya düz)
    if n == 1:
        f.append("[v0]null[vj]")
        f.append("[a0]anull[aj]")
    elif tl.crossfade > 0:
        style = plan.first("transition").style
        d = tl.crossfade
        prev_v, prev_a = "v0", "a0"
        for i in range(1, n):
            out_v = "vj" if i == n - 1 else f"vx{i}"
            out_a = "aj" if i == n - 1 else f"ax{i}"
            f.append(f"[{prev_v}][v{i}]xfade=transition={style}:duration={d:.3f}:offset={tl.offsets[i]:.3f}[{out_v}]")
            f.append(f"[{prev_a}][a{i}]acrossfade=d={d:.3f}:c1=tri:c2=tri[{out_a}]")
            prev_v, prev_a = out_v, out_a
    else:
        f.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vj][aj]")

    # 3) Video sonrası işlemler
    vchain: list[str] = []
    if tl.speed != 1.0:
        vchain.append(f"setpts=PTS/{tl.speed:.4f}")
    f.append(f"[vj]{','.join(vchain) or 'null'}[vsp]")

    reframe = plan.first("reframe")
    mode = reframe.mode if reframe and reframe.aspect_ratio != "original" else "fit"
    if mode == "blur":
        bw, bh = even(W / 4), even(H / 4)
        f.append("[vsp]split[bgs][fgs]")
        f.append(f"[bgs]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},gblur=sigma=10,scale={W}:{H},eq=brightness=-0.08[bg]")
        f.append(f"[fgs]scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]")
        f.append("[bg][fg]overlay=(W-w)/2:(H-h)/2[vfr]")
    elif mode == "crop":
        f.append(f"[vsp]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}[vfr]")
    else:
        f.append(f"[vsp]scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black[vfr]")

    post: list[str] = color_filters(plan.first("color_grade"))
    fade = plan.first("fade")
    if fade and fade.fade_in > 0:
        post.append(f"fade=t=in:st=0:d={min(fade.fade_in, T / 2):.3f}")
    if fade and fade.fade_out > 0:
        d = min(fade.fade_out, T / 2)
        post.append(f"fade=t=out:st={max(0.0, T - d):.3f}:d={d:.3f}")

    sub = plan.first("subtitles")
    texts = plan.all("text")
    words = map_words(transcript_words(req.transcript), tl) if sub and sub.enabled else []
    if (sub and sub.enabled and words) or texts:
        ass = build_ass(W, H, words, sub, texts)
        (req.work_dir / "subs.ass").write_text(ass, encoding="utf-8")
        post.append(f"subtitles=subs.ass:fontsdir={_rel(req.fonts_dir, req.work_dir)}")
    post.append("format=yuv420p")
    f.append(f"[vfr]{','.join(post)}[vout]")

    # 4) Ses sonrası işlemler
    achain: list[str] = []
    if tl.speed != 1.0:
        achain += atempo_chain(tl.speed)
    vol = plan.first("volume")
    if vol and vol.gain != 1.0:
        achain.append(f"volume={vol.gain:.3f}")
    if vol and vol.normalize:
        achain.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    if fade and fade.fade_in > 0:
        achain.append(f"afade=t=in:st=0:d={min(fade.fade_in, T / 2):.3f}")
    if fade and fade.fade_out > 0:
        d = min(fade.fade_out, T / 2)
        achain.append(f"afade=t=out:st={max(0.0, T - d):.3f}:d={d:.3f}")
    f.append(f"[aj]{','.join(achain) or 'anull'}[voice]")
    current = "voice"

    music = plan.first("music")
    music_path = req.resolve_track(music.track) if music else None
    if music and music_path:
        inputs += ["-stream_loop", "-1", "-i", str(music_path)]
        mi = next_input
        next_input += 1
        mchain = [
            "aresample=48000", "aformat=channel_layouts=stereo", f"atrim=0:{T:.3f}", "asetpts=PTS-STARTPTS",
            f"volume={music.volume:.3f}",
        ]
        if music.fade_in > 0:
            mchain.append(f"afade=t=in:st=0:d={min(music.fade_in, T / 2):.3f}")
        if music.fade_out > 0:
            d = min(music.fade_out, T / 2)
            mchain.append(f"afade=t=out:st={max(0.0, T - d):.3f}:d={d:.3f}")
        f.append(f"[{mi}:a]{','.join(mchain)}[mus]")
        if music.ducking and info.has_audio:
            f.append(f"[{current}]asplit[vmain][vside]")
            f.append("[mus][vside]sidechaincompress=threshold=0.03:ratio=9:attack=15:release=350:makeup=1[mduck]")
            f.append("[vmain][mduck]amix=inputs=2:duration=first:normalize=0[mixm]")
        else:
            f.append(f"[{current}][mus]amix=inputs=2:duration=first:normalize=0[mixm]")
        current = "mixm"

    sfx_labels = []
    for k, sfx in enumerate(plan.all("sfx")):
        path = req.resolve_track(sfx.track)
        if not path or sfx.at >= T:
            continue
        inputs += ["-i", str(path)]
        ms = int(sfx.at * 1000)
        f.append(f"[{next_input}:a]aresample=48000,aformat=channel_layouts=stereo,volume={sfx.volume:.3f},adelay={ms}|{ms}[sfx{k}]")
        sfx_labels.append(f"[sfx{k}]")
        next_input += 1
    if sfx_labels:
        f.append(f"[{current}]{''.join(sfx_labels)}amix=inputs={1 + len(sfx_labels)}:duration=first:normalize=0[mixs]")
        current = "mixs"
    f.append(f"[{current}]alimiter=limit=0.95[aout]")

    args = [
        *inputs,
        "-filter_complex", ";".join(f),
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{T:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
        str(req.output),
    ]
    return args, T


def render(req: RenderRequest, on_progress: Callable[[float], None]) -> dict:
    req.work_dir.mkdir(parents=True, exist_ok=True)
    req.output.parent.mkdir(parents=True, exist_ok=True)
    args, total = build_command(req)
    (req.work_dir / "command.txt").write_text(" ".join(f'"{a}"' if " " in a else a for a in args), encoding="utf-8")
    run_ffmpeg_with_progress(args, total, on_progress, cwd=req.work_dir)
    W, H = output_size(req.info, req.plan)
    return {"duration": round(total, 3), "width": W, "height": H}
