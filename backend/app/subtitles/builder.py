"""Altyazı üretimi: kelime gruplama, ASS (stilli) ve SRT/VTT çıktıları."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from ..edit.schema import SubtitlesOp, TextOp
from ..edit.timeline import Timeline
from .emoji import find_emoji_for_segment, find_emoji_for_word


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Cue:
    start: float
    end: float
    words: list[Word]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


AUTO_WORDS = {
    "classic": 7,
    "karaoke": 4,
    "word_pop": 3,
    "boxed": 6,
    "minimal": 7,
    "hormozi": 3,
    "neon": 4,
}
SIZE_FACTOR = {"small": 0.052, "medium": 0.068, "large": 0.088}
SENTENCE_END = (".", "!", "?", "…", ":", ";")


def transcript_words(transcript: dict | None) -> list[Word]:
    words: list[Word] = []
    if not transcript:
        return words
    for seg in transcript.get("segments", []):
        seg_words = seg.get("words") or []
        if seg_words:
            for w in seg_words:
                text = str(w.get("text", "")).strip()
                if text:
                    words.append(Word(text, float(w["start"]), float(w["end"])))
        else:
            words.extend(distribute_words(seg.get("text", ""), float(seg["start"]), float(seg["end"])))
    words.sort(key=lambda w: w.start)
    return words


def distribute_words(text: str, start: float, end: float) -> list[Word]:
    """Segment metnini, kelime uzunluğuna orantılı zamanlarla kelimelere böler."""
    tokens = [t for t in text.split() if t]
    if not tokens:
        return []
    total_chars = sum(len(t) + 1 for t in tokens)
    span = max(0.01, end - start)
    out: list[Word] = []
    cursor = start
    for t in tokens:
        dur = span * (len(t) + 1) / total_chars
        out.append(Word(t, cursor, cursor + dur))
        cursor += dur
    return out


def map_words(words: Iterable[Word], timeline: Optional[Timeline]) -> list[Word]:
    if timeline is None:
        return list(words)
    mapped: list[Word] = []
    for w in words:
        rng = timeline.map_range(w.start, w.end)
        if rng:
            mapped.append(Word(w.text, rng[0], rng[1]))
    return mapped


def group_cues(words: list[Word], max_words: int, max_chars: int = 42, max_gap: float = 0.7) -> list[Cue]:
    cues: list[Cue] = []
    current: list[Word] = []
    for w in words:
        if current:
            gap = w.start - current[-1].end
            chars = sum(len(x.text) + 1 for x in current) + len(w.text)
            if len(current) >= max_words or gap > max_gap or chars > max_chars or current[-1].text.endswith(SENTENCE_END):
                cues.append(Cue(current[0].start, current[-1].end, current))
                current = []
        current.append(w)
    if current:
        cues.append(Cue(current[0].start, current[-1].end, current))
    for i, cue in enumerate(cues):
        nxt = cues[i + 1].start if i + 1 < len(cues) else None
        min_end = cue.start + 0.6
        cue.end = max(cue.end, min_end)
        if nxt is not None:
            if nxt - cue.end < 0.35:
                cue.end = nxt
            cue.end = min(cue.end, nxt)
    return cues


# ---------------------------------------------------------------- ASS ----

def ass_color(hex_color: str, alpha: int = 0) -> str:
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", r"\N")


def _style_line(name: str, font: str, size: int, primary: str, secondary: str, outline: str, back: str,
                bold: bool, border_style: int, outline_w: float, shadow: float, align: int, margin_v: int, margin_h: int) -> str:
    return (
        f"Style: {name},{font},{size},{primary},{secondary},{outline},{back},{-1 if bold else 0},0,0,0,100,100,0,0,"
        f"{border_style},{outline_w:.1f},{shadow:.1f},{align},{margin_h},{margin_h},{margin_v},1"
    )


def _wrap_two_lines(words: list[str], max_chars: int) -> list[str]:
    text = " ".join(words)
    if len(text) <= max_chars or len(words) < 4:
        return words
    best, best_diff = 1, 10**9
    for i in range(1, len(words)):
        diff = abs(len(" ".join(words[:i])) - len(" ".join(words[i:])))
        if diff < best_diff:
            best, best_diff = i, diff
    return words[:best - 1] + [words[best - 1] + r"\N"] + words[best:]


def build_ass(
    width: int,
    height: int,
    words: list[Word],
    sub: Optional[SubtitlesOp],
    texts: list[TextOp],
) -> str:
    short = min(width, height)
    portrait = height > width
    styles: list[str] = []
    events: list[str] = []

    if sub and sub.enabled and words:
        factor = SIZE_FACTOR[sub.size] * (0.78 if sub.style in ("classic", "minimal") else 1.0)
        size = max(18, int(short * factor))
        align = {"bottom": 2, "middle": 5, "top": 8}[sub.position]
        margin_v = int(height * (0.16 if portrait else 0.08)) if sub.position != "middle" else 0
        margin_h = int(width * 0.06)
        primary = ass_color(sub.primary_color)
        highlight = ass_color(sub.highlight_color)
        outline = ass_color(sub.outline_color)
        shadow_col = ass_color("#000000", 0x80)
        bord = max(1.5, size * 0.07)
        if sub.style == "classic":
            styles.append(_style_line("Sub", sub.font, size, primary, primary, outline, shadow_col, True, 1, bord * 0.8, size * 0.03, align, margin_v, margin_h))
        elif sub.style == "karaoke":
            styles.append(_style_line("Sub", sub.font, size, highlight, primary, outline, shadow_col, True, 1, bord, size * 0.04, align, margin_v, margin_h))
        elif sub.style == "word_pop":
            styles.append(_style_line("Sub", sub.font, size, primary, primary, outline, shadow_col, True, 1, bord * 1.1, size * 0.05, align, margin_v, margin_h))
        elif sub.style == "hormozi":
            h_size = max(22, int(size * 1.15))
            styles.append(_style_line("Sub", sub.font, h_size, primary, primary, outline, shadow_col, True, 1, bord * 1.5, h_size * 0.07, align, margin_v, margin_h))
        elif sub.style == "neon":
            neon_out = ass_color(sub.outline_color if sub.outline_color != "#000000" else "#00F0FF")
            styles.append(_style_line("Sub", sub.font, size, primary, primary, neon_out, shadow_col, True, 1, bord * 1.6, size * 0.05, align, margin_v, margin_h))
        elif sub.style == "boxed":
            box = ass_color(sub.outline_color, 0x50)
            styles.append(_style_line("Sub", sub.font, size, primary, primary, box, box, True, 3, size * 0.18, 0, align, margin_v, margin_h))
        else:  # minimal
            styles.append(_style_line("Sub", sub.font, size, primary, primary, outline, ass_color("#000000", 0x60), False, 1, 0, size * 0.05, align, margin_v, margin_h))

        max_words = sub.max_words_per_line or AUTO_WORDS[sub.style]
        max_chars = int(width / (size * 0.55)) * (2 if sub.style in ("classic", "minimal", "boxed") else 1)
        cues = group_cues(words, max_words=max_words, max_chars=max(12, max_chars))

        def fmt(t: str) -> str:
            t = ass_escape(t)
            return t.upper() if (sub.uppercase or sub.style == "hormozi") else t

        for cue in cues:
            if sub.style == "karaoke":
                parts = []
                for i, w in enumerate(cue.words):
                    nxt = cue.words[i + 1].start if i + 1 < len(cue.words) else cue.end
                    lead = (w.start - cue.start) if i == 0 else 0.0
                    if lead > 0.01:
                        parts.append(f"{{\\k{int(round(lead * 100))}}}")
                    emo = f"{find_emoji_for_word(w.text)} " if sub.auto_emojis and find_emoji_for_word(w.text) else ""
                    parts.append(f"{{\\k{max(1, int(round((nxt - w.start) * 100)))}}}{emo}{fmt(w.text)} ")
                text = "{\\fad(80,60)}" + "".join(parts).rstrip()
                events.append(f"Dialogue: 0,{ass_time(cue.start)},{ass_time(cue.end)},Sub,,0,0,0,,{text}")
            elif sub.style in ("word_pop", "hormozi", "neon"):
                for i, w in enumerate(cue.words):
                    s = cue.start if i == 0 else w.start
                    e = cue.words[i + 1].start if i + 1 < len(cue.words) else cue.end
                    if e - s < 0.01:
                        continue
                    chunks = []
                    for j, other in enumerate(cue.words):
                        emo = find_emoji_for_word(other.text) if (sub.auto_emojis or sub.style == "hormozi") else None
                        emo_str = f"{emo} " if emo else ""
                        word_str = fmt(other.text)
                        if j == i:
                            if sub.style == "hormozi":
                                bounce = r"\t(0,60,\fscx126\fscy126)\t(60,130,\fscx116\fscy116)" if sub.bounce else r"\fscx116\fscy116"
                                chunks.append(f"{{\\c{highlight}\\fscx100\\fscy100{bounce}}}{emo_str}{word_str}{{\\c{primary}\\fscx100\\fscy100}}")
                            elif sub.style == "neon":
                                chunks.append(f"{{\\c{highlight}\\fscx112\\fscy112}}{emo_str}{word_str}{{\\c{primary}\\fscx100\\fscy100}}")
                            else:  # word_pop
                                chunks.append(f"{{\\c{highlight}\\fscx100\\fscy100\\t(0,90,\\fscx116\\fscy116)}}{emo_str}{word_str}{{\\c{primary}\\fscx100\\fscy100}}")
                        else:
                            chunks.append(word_str)
                    events.append(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Sub,,0,0,0,,{' '.join(chunks)}")
            else:
                cue_emo = find_emoji_for_segment(cue.text) if sub.auto_emojis else None
                prefix = f"{cue_emo} " if cue_emo else ""
                tokens = _wrap_two_lines([fmt(w.text) for w in cue.words], max(12, max_chars // 2))
                text = prefix + " ".join(tokens).replace(r"\N ", r"\N")
                fade = "{\\fad(120,80)}" if sub.style == "minimal" else ""
                events.append(f"Dialogue: 0,{ass_time(cue.start)},{ass_time(cue.end)},Sub,,0,0,0,,{fade}{text}")

    styles.append(_style_line("Title", "Montserrat", int(short * 0.09), ass_color("#FFFFFF"), ass_color("#FFFFFF"),
                              ass_color("#000000"), ass_color("#000000", 0x70), True, 1, short * 0.006, short * 0.004, 5, 0, 0))
    styles.append(_style_line("TitleBox", "Montserrat", int(short * 0.09), ass_color("#FFFFFF"), ass_color("#FFFFFF"),
                              ass_color("#000000", 0x40), ass_color("#000000", 0x40), True, 3, short * 0.02, 0, 5, 0, 0))

    for t in texts:
        size = int(short * {"small": 0.055, "medium": 0.075, "large": 0.1}[t.size])
        x = width // 2
        y, an = {"top": (int(height * 0.12), 8), "middle": (height // 2, 5), "bottom": (int(height * 0.86), 2)}[t.position]
        base = f"\\an{an}\\fn{t.font}\\fs{size}\\c{ass_color(t.color)}"
        body = ass_escape(t.text)
        dur_ms = int(t.duration * 1000)
        if t.animation == "fade":
            tags = f"{base}\\pos({x},{y})\\fad(300,300)"
        elif t.animation == "fade_up":
            tags = f"{base}\\move({x},{y + int(short * 0.05)},{x},{y},0,400)\\fad(350,300)"
        elif t.animation == "pop":
            tags = f"{base}\\pos({x},{y})\\fscx30\\fscy30\\t(0,180,\\fscx112\\fscy112)\\t(180,320,\\fscx100\\fscy100)\\fad(0,250)"
        elif t.animation == "typewriter":
            step = max(20, min(90, int(dur_ms * 0.5 / max(1, len(t.text)))))
            body = "".join(
                f"{{\\alpha&HFF&\\t({i * step},{i * step + 1},\\alpha&H00&)}}{ass_escape(ch)}" for i, ch in enumerate(t.text)
            )
            tags = f"{base}\\pos({x},{y})\\fad(0,250)"
        else:
            tags = f"{base}\\pos({x},{y})"
        style = "TitleBox" if t.background else "Title"
        events.append(f"Dialogue: 1,{ass_time(t.start)},{ass_time(t.start + t.duration)},{style},,0,0,0,,{{{tags}}}{body}")

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *styles,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
        "",
    ]
    return "\n".join(header)


# ------------------------------------------------------------ SRT / VTT ----

def _srt_time(t: float, sep: str = ",") -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def cues_for_export(words: list[Word]) -> list[Cue]:
    return group_cues(words, max_words=12, max_chars=84)


def to_srt(cues: list[Cue]) -> str:
    blocks = []
    for i, c in enumerate(cues, 1):
        lines = _wrap_two_lines([w.text for w in c.words], 42)
        text = " ".join(lines).replace(r"\N ", "\n").replace(r"\N", "\n")
        blocks.append(f"{i}\n{_srt_time(c.start)} --> {_srt_time(c.end)}\n{text}\n")
    return "\n".join(blocks)


def to_vtt(cues: list[Cue]) -> str:
    blocks = ["WEBVTT\n"]
    for c in cues:
        lines = _wrap_two_lines([w.text for w in c.words], 42)
        text = " ".join(lines).replace(r"\N ", "\n").replace(r"\N", "\n")
        blocks.append(f"{_srt_time(c.start, '.')} --> {_srt_time(c.end, '.')}\n{text}\n")
    return "\n".join(blocks)
