import copy
import zipfile
from pathlib import Path

import pytest

from app import jobs
from app.models import Project
from app.publishing import ClipExportBody


@pytest.fixture
def published(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    monkeypatch.setattr(jobs, "_save_project", lambda *_: pytest.fail("Independent publishing must not change the project"))
    source = tmp_path / "source.mp4"
    source.write_bytes(b"unchanged-source")
    p = Project(id="reuse", name="Reuse", source_file="source.mp4", duration=80, width=160, height=90, status="ready")
    options = ClipExportBody(analysis_id="abcdef123456", clip_ids=[22, 5], aspect_ratios=["9:16", "1:1"],
                             resolution="720p", quality="fast", fill="fit").model_dump()
    clips = [{"id": 22, "start": 40, "end": 70, "cover_at": 0}, {"id": 5, "start": 0, "end": 30, "cover_at": 0}]
    calls = []
    def fake_render(req, progress):
        calls.append(req.output.name)
        req.output.write_bytes(f"video:{len(calls)}:{req.output.stem}:{req.plan.model_dump_json()}".encode())
        return {"duration": req.timeline.output_duration, "width": 720, "height": 720}
    monkeypatch.setattr(jobs, "render", fake_render)
    monkeypatch.setattr(jobs, "make_thumbnail", lambda video, thumb, **_: thumb.write_bytes(b"jpg:" + video.read_bytes()))
    result = jobs.task_publish(lambda *_: None, p.model_dump(), options, clips)
    calls.clear()
    previous = {"project_id": p.id, "result": result}
    def path(url):
        return tmp_path / url.split("/projects/reuse/")[1]
    def run(new_clips=None, new_options=None, project=None, reuse=None):
        return jobs.task_publish(lambda *_: None, (project or p).model_dump(),
                                 new_options or options, clips if new_clips is None else new_clips,
                                 previous if reuse is None else reuse)
    return p, options, clips, previous, calls, path, run, source


def test_unchanged_pairs_are_copied_and_all_archives_rebuilt(published, monkeypatch):
    p, _, _, previous, calls, path, run, _ = published
    before = copy.deepcopy(previous)
    old_files = {url: path(url).read_bytes() for out in previous["result"]["outputs"] for url in (out["output"], out["thumbnail"])}
    monkeypatch.setattr(jobs, "render", lambda *_: pytest.fail("Verified pairs must not render again"))
    monkeypatch.setattr(jobs, "make_thumbnail", lambda *_, **__: pytest.fail("Verified JPGs must not be extracted again"))
    result = run()
    assert calls == []
    assert (result["reused_outputs"], result["rendered_outputs"]) == (4, 0)
    for old, new in zip(previous["result"]["outputs"], result["outputs"]):
        assert new["reused"] is True
        for key in ("output", "thumbnail"):
            assert path(new[key]).read_bytes() == old_files[old[key]]
            assert path(old[key]).read_bytes() == old_files[old[key]]
            assert not path(new[key]).samefile(path(old[key]))
    with zipfile.ZipFile(path(result["archive"])) as zf:
        assert len(zf.namelist()) == 8
    assert len(result["clip_archives"]) == len(result["format_archives"]) == 2
    assert result["clip_request"] == previous["result"]["clip_request"]
    assert previous == before
    assert p.output_file is None


def test_changed_range_renders_only_that_clip(published):
    _, _, clips, _, calls, _, run, _ = published
    changed = copy.deepcopy(clips)
    changed[0]["start"] = 39
    result = run(new_clips=changed)
    assert len(calls) == 2
    assert (result["reused_outputs"], result["refreshed_covers"], result["rendered_outputs"]) == (2, 0, 2)
    assert [out["reused"] for out in result["outputs"]] == [False, False, True, True]
    assert result["clip_request"]["clips"][0]["start"] == 39


def test_cover_only_change_reuses_video_and_regenerates_only_jpg(published, monkeypatch):
    _, _, clips, previous, calls, path, run, _ = published
    before = copy.deepcopy(previous)
    old_videos = {out["label"]: path(out["output"]).read_bytes() for out in previous["result"]["outputs"]}
    old_thumbs = {out["label"]: path(out["thumbnail"]).read_bytes() for out in previous["result"]["outputs"]}
    extractions = []

    def fake_thumbnail(video, thumb, *, at):
        extractions.append((thumb.name, at))
        thumb.write_bytes(f"new-cover:{thumb.name}:{at}".encode())

    monkeypatch.setattr(jobs, "make_thumbnail", fake_thumbnail)
    monkeypatch.setattr(jobs, "render", lambda *_: pytest.fail("Cover-only changes must reuse verified MP4s"))
    changed = copy.deepcopy(clips)
    changed[0]["cover_at"] = 1
    result = run(new_clips=changed)
    assert calls == [] and len(extractions) == 2
    assert {name for name, _ in extractions} == {"clip_01_reels_tiktok.jpg", "clip_01_instagram_square.jpg"}
    assert (result["reused_outputs"], result["refreshed_covers"], result["rendered_outputs"]) == (2, 2, 0)
    assert [out["video_reused"] for out in result["outputs"]] == [True] * 4
    assert [out["cover_refreshed"] for out in result["outputs"]] == [True, True, False, False]
    assert [out["reused"] for out in result["outputs"]] == [False, False, True, True]
    for out in result["outputs"]:
        assert path(out["output"]).read_bytes() == old_videos[out["label"]], "MP4 content must be identical"
        if out["cover_refreshed"]:
            assert path(out["thumbnail"]).read_bytes() != old_thumbs[out["label"]], "JPG must be a new frame"
        else:
            assert path(out["thumbnail"]).read_bytes() == old_thumbs[out["label"]], "Unchanged JPG must be copied"
    assert result["clip_request"]["clips"][0]["cover_at"] == 1
    assert previous == before


@pytest.mark.parametrize("change,expected", [("reorder-clips", (4, 0)), ("reorder-formats", (4, 0)),
                                          ("remove-clip", (2, 0)), ("remove-format", (2, 0)),
                                          ("add-format", (4, 2)), ("add-clip", (4, 2))])
def test_selection_and_format_changes_reuse_matching_pairs(published, change, expected):
    _, options, clips, previous, calls, path, run, _ = published
    changed, opts = copy.deepcopy(clips), copy.deepcopy(options)
    if change == "reorder-clips": changed.reverse()
    if change == "reorder-formats": opts["aspect_ratios"].reverse()
    if change == "remove-clip": changed = changed[1:]
    if change == "remove-format": opts["aspect_ratios"] = ["1:1"]
    if change == "add-format": opts["aspect_ratios"].append("4:5")
    if change == "add-clip": changed.append({"id": 77, "start": 10, "end": 40, "cover_at": 0})
    result = run(new_clips=changed, new_options=opts)
    assert (result["reused_outputs"], result["rendered_outputs"]) == expected
    assert len(calls) == expected[1]
    assert result["clip_request"]["aspect_ratios"] == opts["aspect_ratios"]
    for out in result["outputs"]:
        current_id = changed[out["clip_index"] - 1]["id"]
        if out["reused"]:
            old_index = next(i for i, c in enumerate(clips, 1) if c["id"] == current_id)
            old = next(o for o in previous["result"]["outputs"] if o["clip_index"] == old_index and o["aspect_ratio"] == out["aspect_ratio"])
            assert path(out["output"]).read_bytes() == path(old["output"]).read_bytes()
    with zipfile.ZipFile(path(result["archive"])) as zf:
        assert len(zf.namelist()) == len(changed) * len(opts["aspect_ratios"]) * 2


@pytest.mark.parametrize("change", ["resolution", "quality", "fill", "analysis", "revision", "source", "legacy-source", "legacy-files", "foreign"])
def test_global_or_unverifiable_inputs_force_render(published, change):
    p, options, _, previous, calls, _, run, source = published
    opts, old = copy.deepcopy(options), copy.deepcopy(previous)
    if change == "resolution": opts["resolution"] = "1080p"
    if change == "quality": opts["quality"] = "high"
    if change == "fill": opts["fill"] = "crop"
    if change == "analysis": opts["analysis_id"] = "111111111111"
    if change == "revision": p.plan = {"operations": [{"type": "color_grade", "preset": "warm"}]}
    if change == "source": source.write_bytes(b"replacement-source-at-same-path")
    if change == "legacy-source": old["result"]["clip_request"].pop("source_sha256")
    if change == "legacy-files":
        for out in old["result"]["outputs"]: out.pop("sha256")
    if change == "foreign": old["project_id"] = "other-project"
    result = run(new_options=opts, reuse=old)
    assert len(calls) == 4
    assert result["reused_outputs"] == 0


@pytest.mark.parametrize("key,action,expected", [
    ("output", "missing", (3, 0, 1)), ("output", "corrupt", (3, 0, 1)),
    ("thumbnail", "missing", (3, 1, 0)), ("thumbnail", "corrupt", (3, 1, 0)),
])
def test_missing_or_modified_files_fall_back_safely(published, key, action, expected):
    _, _, _, previous, calls, path, run, _ = published
    damaged = path(previous["result"]["outputs"][0][key])
    if action == "missing": damaged.unlink()
    else: damaged.write_bytes(b"changed-file")
    result = run()
    assert (result["reused_outputs"], result["refreshed_covers"], result["rendered_outputs"]) == expected
    assert len(calls) == expected[2]


@pytest.mark.parametrize("url", ["https://example.test/video.mp4", "/media/projects/other/outputs/" + "a" * 32 + "/clip_01_reels_tiktok.mp4",
                                "/media/projects/reuse/outputs/../source.mp4", "/media/projects/reuse/outputs/%2e%2e/source.mp4"])
def test_unsafe_paths_are_not_read_or_reused(published, monkeypatch, url):
    from app import clip_reuse
    _, _, _, previous, calls, _, run, _ = published
    old = copy.deepcopy(previous)
    old["result"]["outputs"][0]["output"] = url
    original_hash = clip_reuse.file_sha256
    reads = []
    def checked_hash(path):
        reads.append(path)
        assert path.suffix in (".mp4", ".jpg") and path.parent.parent.name == "outputs"
        return original_hash(path)
    monkeypatch.setattr(clip_reuse, "file_sha256", checked_hash)
    result = run(reuse=old)
    assert len(calls) == 1 and result["reused_outputs"] == 3
    assert len(reads) == 6  # Only the other three verified pairs.


def test_symlinked_pair_is_not_reused(published):
    _, _, _, previous, calls, path, run, _ = published
    video = path(previous["result"]["outputs"][0]["output"])
    target = video.parent.parent.parent / "outside.mp4"
    target.write_bytes(video.read_bytes())
    video.unlink()
    try:
        video.symlink_to(target)
    except OSError:
        pytest.skip("Host does not allow creating symlinks")
    from app import clip_reuse
    assert clip_reuse._output_path(previous["result"]["outputs"][0]["output"], "reuse", video.parent.parent.parent, video.stem, ".mp4") is None
    before = target.read_bytes()
    result = run()
    assert len(calls) == 1 and result["reused_outputs"] == 3
    assert target.read_bytes() == before


def test_resolved_path_redirection_is_rejected_without_symlink_privileges(published, monkeypatch):
    _, _, _, previous, calls, path, run, _ = published
    video = path(previous["result"]["outputs"][0]["output"])
    outside = video.parent.parent.parent / "redirected.mp4"
    original_resolve = Path.resolve
    def redirected(self, *args, **kwargs):
        return outside if self == video else original_resolve(self, *args, **kwargs)
    monkeypatch.setattr(Path, "resolve", redirected)
    result = run()
    assert len(calls) == 1 and result["reused_outputs"] == 3
    assert not outside.exists()


@pytest.mark.parametrize("change,rendered,refreshed", [
    ("duplicate-clips", 4, 0), ("duplicate-pair", 1, 0), ("missing-index", 1, 0),
    ("bad-width", 1, 0), ("bad-cover", 0, 1), ("split-pair", 0, 1),
])
def test_ambiguous_or_invalid_metadata_never_claims_full_reuse(published, change, rendered, refreshed):
    _, _, _, previous, calls, path, run, _ = published
    old = copy.deepcopy(previous); out = old["result"]["outputs"][0]
    if change == "duplicate-clips": old["result"]["clip_request"]["clips"].append(copy.deepcopy(old["result"]["clip_request"]["clips"][0]))
    if change == "duplicate-pair": old["result"]["outputs"].append(copy.deepcopy(out))
    if change == "missing-index": out.pop("clip_index")
    if change == "bad-width": out["width"] = True
    if change == "bad-cover": out["cover_at"] = float("nan")
    if change == "split-pair":
        old_thumb = path(out["thumbnail"])
        other_dir = old_thumb.parent.parent / ("f" * 32); other_dir.mkdir()
        (other_dir / old_thumb.name).write_bytes(old_thumb.read_bytes())
        out["thumbnail"] = out["thumbnail"].replace(old_thumb.parent.name, other_dir.name)
    result = run(reuse=old)
    assert len(calls) == rendered
    assert result["rendered_outputs"] == rendered
    assert result["refreshed_covers"] == refreshed
    assert result["reused_outputs"] == 4 - rendered - refreshed
    # Reused MP4s are verified independently from their cover metadata.
    assert sum(1 for out in result["outputs"] if out["video_reused"]) == 4 - rendered


@pytest.mark.parametrize("failure", ["read-error", "copy-corruption"])
def test_copy_failures_fall_back_to_render(published, monkeypatch, failure):
    _, _, _, _, calls, _, run, _ = published
    real_copy = jobs.shutil.copyfile
    failed = False
    def copy_file(src, dst):
        nonlocal failed
        if not failed:
            failed = True
            if failure == "read-error": raise OSError("missing source during copy")
            Path(dst).write_bytes(b"bad-copy")
            return dst
        return real_copy(src, dst)
    monkeypatch.setattr(jobs.shutil, "copyfile", copy_file)
    result = run()
    assert len(calls) == 1 and result["reused_outputs"] == 3


def test_source_change_during_job_never_returns_mixed_result(published, monkeypatch):
    _, _, clips, _, _, _, run, source = published
    original_render = jobs.render
    def changed_source(req, progress):
        result = original_render(req, progress)
        source.write_bytes(b"source changed during job")
        return result
    monkeypatch.setattr(jobs, "render", changed_source)
    changed = copy.deepcopy(clips); changed[0]["start"] = 39
    with pytest.raises(ValueError, match="Kaynak dosya"):
        run(new_clips=changed)


def test_unverifiable_source_fails_before_creating_outputs_or_rendering(published):
    _, _, _, previous, calls, path, run, source = published
    output_root = path(previous["result"]["archive"]).parent.parent
    existing = set(output_root.iterdir())
    source.unlink()
    with pytest.raises(ValueError, match="Kaynak dosya doğrulanamadı"):
        run()
    assert calls == []
    assert set(output_root.iterdir()) == existing


def test_real_incremental_clip_render_preserves_other_pairs(tmp_path, monkeypatch):
    from app.ffmpeg import run_ffmpeg, probe
    monkeypatch.setattr(jobs, "project_dir", lambda _: tmp_path)
    source = tmp_path / "source.mp4"
    run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", str(source)])
    p = Project(id="realreuse", name="Real reuse", source_file="source.mp4", duration=1, width=160, height=90, status="ready")
    opts = ClipExportBody(analysis_id="abcdef123456", clip_ids=[22, 5], aspect_ratios=["9:16", "1:1"], resolution="720p", quality="fast", fill="fit").model_dump()
    clips = [{"id": 22, "start": 0.1, "end": 0.5}, {"id": 5, "start": 0.5, "end": 0.9}]
    first = jobs.task_publish(lambda *_: None, p.model_dump(), opts, clips)
    before = copy.deepcopy(first)
    changed = copy.deepcopy(clips); changed[0]["start"] = 0
    calls = []
    original_render = jobs.render
    def track(req, progress):
        calls.append(req.output.name)
        return original_render(req, progress)
    monkeypatch.setattr(jobs, "render", track)
    second = jobs.task_publish(lambda *_: None, p.model_dump(), opts, changed, {"project_id": p.id, "result": first})
    assert len(calls) == 2
    assert (second["reused_outputs"], second["rendered_outputs"]) == (2, 2)
    def path(url): return tmp_path / url.split("/projects/realreuse/")[1]
    for old, new in zip(first["outputs"][2:], second["outputs"][2:]):
        assert new["reused"] and path(new["output"]).read_bytes() == path(old["output"]).read_bytes()
        assert probe(path(new["output"])).duration == pytest.approx(0.4, abs=0.15)
        assert new["sha256"] == old["sha256"] and new["thumbnail_sha256"] == old["thumbnail_sha256"]
    with zipfile.ZipFile(path(second["archive"])) as zf:
        assert len(zf.namelist()) == 8
    assert first == before

    # A cover-only change keeps verified MP4s and only extracts new JPG frames.
    second_before = copy.deepcopy(second)
    covered = copy.deepcopy(changed)
    covered[1]["cover_at"] = 0.2
    calls.clear()
    real_thumbnail = jobs.make_thumbnail
    extracted = []

    def track_thumbnail(video, thumb, *, at):
        extracted.append((thumb.name, at))
        return real_thumbnail(video, thumb, at=at)

    monkeypatch.setattr(jobs, "make_thumbnail", track_thumbnail)
    third = jobs.task_publish(lambda *_: None, p.model_dump(), opts, covered,
                              {"project_id": p.id, "result": second})
    assert calls == [] and len(extracted) == 2
    assert (third["reused_outputs"], third["refreshed_covers"], third["rendered_outputs"]) == (2, 2, 0)
    for old, new in zip(second["outputs"][2:], third["outputs"][2:]):
        assert new["cover_refreshed"] and not new["reused"]
        assert path(new["output"]).read_bytes() == path(old["output"]).read_bytes()
        assert new["sha256"] == old["sha256"]
        assert new["thumbnail_sha256"] != old["thumbnail_sha256"]
        assert new["cover_at"] == pytest.approx(old["cover_at"] + 0.2, abs=0.05)
        assert new["thumbnail_fallback"] is False
        assert probe(path(new["output"])).duration == pytest.approx(0.4, abs=0.15)
    assert second == second_before
