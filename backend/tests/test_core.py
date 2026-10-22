"""ClipCut çekirdek testleri: DSL, zaman çizelgesi, altyazı, mock planlayıcı ve uçtan uca render."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("MOCK_AI", "true")

from app.ai import mock  # noqa: E402
from app.edit.schema import EditPlan  # noqa: E402
from app.edit.timeline import build_timeline, subtract  # noqa: E402
from app.subtitles.builder import build_ass, group_cues, map_words, to_srt, transcript_words  # noqa: E402


def test_subtract():
    assert subtract([(0, 10)], (2, 4)) == [(0, 2), (4, 10)]
    assert subtract([(0, 10)], (-1, 11)) == []
    assert subtract([(0, 5), (6, 10)], (4, 7)) == [(0, 4), (7, 10)]


def test_plan_dedupes_singletons_and_validates():
    plan = EditPlan.model_validate({"operations": [
        {"type": "speed", "factor": 1.5}, {"type": "text", "text": "A"}, {"type": "speed", "factor": 2},
        {"type": "text", "text": "B"},
    ]})
    assert [o.type for o in plan.operations] == ["text", "speed", "text"]
    assert plan.first("speed").factor == 2
    with pytest.raises(Exception):
        EditPlan.model_validate({"operations": [{"type": "speed", "factor": 10}]})


def test_timeline_mapping_with_cuts_speed_and_crossfade():
    plan = EditPlan.model_validate({"operations": [
        {"type": "cut_range", "start": 2, "end": 4}, {"type": "speed", "factor": 2},
        {"type": "transition", "style": "fade", "duration": 0.5},
    ]})
    tl = build_timeline(plan, 10.0)
    assert tl.segments == [(0.0, 2.0), (4.0, 10.0)]
    assert tl.crossfade == 0.5
    assert tl.output_duration == pytest.approx((2 + 6 - 0.5) / 2)
    assert tl.map_time(3.0) is None
    assert tl.map_time(5.0) == pytest.approx((1.5 + 1.0) / 2)


def test_silence_removal_uses_provider():
    plan = EditPlan.model_validate({"operations": [{"type": "remove_silence", "padding_ms": 100}]})
    tl = build_timeline(plan, 10.0, lambda thr, d: [(3.0, 5.0)])
    assert tl.segments == [(0.0, 3.1), (4.9, 10.0)]


def test_subtitle_grouping_and_ass_styles():
    tr = mock.transcript(12.0)
    words = transcript_words(tr)
    assert words and words[0].start >= 0
    cues = group_cues(words, max_words=4)
    assert all(len(c.words) <= 4 for c in cues)
    assert all(c.end > c.start for c in cues)
    for style in ("classic", "karaoke", "word_pop", "boxed", "minimal"):
        plan = EditPlan.model_validate({"operations": [{"type": "subtitles", "style": style}, {"type": "text", "text": "Başlık", "animation": "typewriter"}]})
        ass = build_ass(1080, 1920, words, plan.first("subtitles"), plan.all("text"))
        assert "[Events]" in ass and "Dialogue:" in ass
    assert "\\k" in build_ass(1080, 1920, words, EditPlan.model_validate({"operations": [{"type": "subtitles", "style": "karaoke"}]}).first("subtitles"), [])
    assert "-->" in to_srt(cues)


def test_words_shift_after_cut():
    tr = mock.transcript(12.0)
    plan = EditPlan.model_validate({"operations": [{"type": "cut_range", "start": 0, "end": 3}]})
    tl = build_timeline(plan, 12.0)
    mapped = map_words(transcript_words(tr), tl)
    assert mapped and mapped[0].start < 1.0


def test_mock_planner_turkish_prompt():
    plan, summary = mock.plan_edit(
        "Sessiz yerleri at, dikey yap, sarı karaoke altyazı ekle, lofi müzik koy, sinematik renk ve 'Yeni Ürün' başlığı ekle",
        EditPlan(), {"duration": 20},
    )
    types = {o.type for o in plan.operations}
    assert {"remove_silence", "reframe", "subtitles", "music", "color_grade", "text"} <= types
    assert plan.first("reframe").aspect_ratio == "9:16"
    assert plan.first("subtitles").highlight_color == "#FFD400"
    assert plan.first("text").text == "Yeni Ürün"
    plan2, _ = mock.plan_edit("10 ile 12. saniye arasını kes", plan, {"duration": 20})
    assert plan2.first("cut_range").start == 10


@pytest.mark.slow
def test_end_to_end_render(tmp_path: Path):
    from app import assets
    from app.edit.renderer import RenderRequest, render
    from app.ffmpeg import probe

    assets.ensure_assets()
    src = tmp_path / "src.mp4"
    mock.generate_video("Test sahnesi", "16:9", 6, src, lambda *_: None)
    info = probe(src)
    assert info.has_video and info.duration > 5

    plan = EditPlan.model_validate({"operations": [
        {"type": "cut_range", "start": 2, "end": 3},
        {"type": "transition", "style": "slideleft", "duration": 0.4},
        {"type": "reframe", "aspect_ratio": "9:16", "mode": "blur"},
        {"type": "color_grade", "preset": "cinematic", "vignette": True},
        {"type": "subtitles", "style": "word_pop"},
        {"type": "music", "track": "lofi_chill", "volume": 0.2},
        {"type": "sfx", "track": "whoosh", "at": 1.6},
        {"type": "fade", "fade_in": 0.5, "fade_out": 0.5},
        {"type": "text", "text": "ClipCut", "start": 0, "duration": 2, "animation": "pop"},
        {"type": "speed", "factor": 1.25},
    ]})
    tl = build_timeline(plan, info.duration)
    out = tmp_path / "out.mp4"
    meta = render(RenderRequest(
        source=src, info=info, plan=plan, timeline=tl, transcript=mock.transcript(info.duration),
        work_dir=tmp_path / "work", output=out, fonts_dir=assets.fonts_dir(),
        resolve_track=lambda t: assets.resolve_track(t, None),
    ), lambda _: None)
    res = probe(out)
    assert (res.width, res.height) == (1080, 1920)
    assert res.has_audio
    assert abs(res.duration - meta["duration"]) < 0.4


def test_voiceover_generation(tmp_path: Path):
    from app.ai import tts

    voices = tts.list_voices()
    assert len(voices) >= 3
    out_audio = tmp_path / "vo.mp3"
    result = tts.generate_voiceover("ClipCut yapay zeka seslendirme testi.", voice_id="tr-TR-EmelNeural", out_path=out_audio)
    assert out_audio.exists()
    assert result["duration"] > 0
    assert len(result["words"]) >= 4
    assert result["words"][0]["start"] >= 0


def test_broll_suggestions_and_overlay_plan(tmp_path: Path):
    from app.ai import broll
    from app.edit.schema import EditPlan, OverlayOp

    stock = broll.list_stock_broll()
    assert len(stock) >= 5

    transcript = {
        "language": "tr",
        "segments": [
            {"id": 0, "start": 0.5, "end": 3.0, "text": "Yapay zeka teknolojisi cok hizli gelisiyor.", "words": []},
            {"id": 1, "start": 3.5, "end": 6.0, "text": "Bu yontemle para ve finans kazanclari artiyor.", "words": []},
        ],
    }
    suggs = broll.suggest_broll_for_transcript(transcript, 8.0)
    assert len(suggs) >= 1
    assert suggs[0]["type"] == "overlay"
    assert "asset:broll:" in suggs[0]["track"]

    plan = EditPlan.model_validate({"operations": [
        {"type": "overlay", "track": "asset:broll:tech", "start": 1.0, "duration": 2.5, "mode": "pip", "position": "top_right"},
    ]})
    assert len(plan.all("overlay")) == 1
    assert plan.all("overlay")[0].mode == "pip"


def test_emoji_and_hormozi_subtitles():
    from app.ai import mock
    from app.edit.schema import EditPlan, SubtitlesOp
    from app.subtitles.builder import Word, build_ass
    from app.subtitles.emoji import find_emoji_for_segment, find_emoji_for_word

    # 1. Emoji sözlük doğrulaması
    assert find_emoji_for_word("ateş") == "🔥"
    assert find_emoji_for_word("roket") == "🚀"
    assert find_emoji_for_word("para") == "💰"
    assert find_emoji_for_word("fikir") == "💡"
    assert find_emoji_for_word("growth") == "📈"
    assert find_emoji_for_segment("bu inanılmaz bir teknoloji") in ["🔥", "🤖"]

    # 2. Hormozi & Neon ASS çıktı doğrulaması
    words = [
        Word(text="Bu", start=0.0, end=0.4),
        Word(text="ateş", start=0.4, end=0.8),
        Word(text="gibi", start=0.8, end=1.2),
        Word(text="büyük", start=1.2, end=1.5),
        Word(text="para", start=1.5, end=2.0),
    ]
    sub = SubtitlesOp(style="hormozi", auto_emojis=True, uppercase=True, highlight_color="#FFE600")
    ass = build_ass(1080, 1920, words, sub, [])
    assert "Sub" in ass
    assert "Dialogue:" in ass
    assert "🔥" in ass or "💰" in ass
    assert r"\fscx" in ass

    # 3. Prompt planlayıcı Hormozi algılama
    plan, msg = mock.plan_edit("Hormozi tarzı altyazı ekle", EditPlan(), {"duration": 10.0})
    sub_op = plan.first("subtitles")
    assert sub_op is not None
    assert sub_op.style == "hormozi"
    assert sub_op.auto_emojis is True
    assert sub_op.uppercase is True


