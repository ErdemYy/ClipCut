import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017,
  } }).outputText;
  const exported = {};
  vm.runInNewContext(js, { exports: exported, require(name) { throw new Error(`Unexpected import ${name}`); } });
  return exported;
}
const { clipExportFreshness, clipExportItemFreshness } = load("../lib/clip-export.ts");

const result = {
  archive: "/archive.zip",
  outputs: [],
  clip_request: {
    analysis_id: "abcdef123456",
    clips: [
      { id: 1, start: 10.25, end: 50.25, cover_at: 12.5 },
      { id: 0, start: 60, end: 90, cover_at: 0 },
    ],
    aspect_ratio: "4:5", aspect_ratios: ["4:5", "1:1"],
    fill: "crop",
    resolution: "1080p",
    quality: "standard",
    render_revision: "revision-a",
  },
};
const input = {
  analysisId: "abcdef123456",
  clips: [
    { id: 1, start: 10.25, end: 50.25, cover: 12.5 },
    { id: 0, start: 60, end: 90, cover: 0 },
  ],
  aspects: ["4:5", "1:1"],
  fill: "crop",
  options: { resolution: "1080p", quality: "standard" },
  renderRevision: "revision-a",
};
const freshness = (patch = {}) => clipExportFreshness(result, { ...input, ...patch });

test("fresh only when ordered clips, ranges, covers, format and render inputs all match", () => {
  assert.equal(freshness(), "fresh");
  assert.equal(freshness({ analysisId: "ffffffffffff" }), "stale");
  assert.equal(freshness({ aspects: ["9:16"] }), "stale");
  assert.equal(freshness({ aspects: ["4:5"] }), "stale");
  assert.equal(freshness({ aspects: ["4:5", "1:1", "16:9"] }), "stale");
  assert.equal(freshness({ aspects: ["1:1", "4:5"] }), "stale");
  assert.equal(freshness({ fill: "fit" }), "stale");
  assert.equal(freshness({ options: { resolution: "720p", quality: "standard" } }), "stale");
  assert.equal(freshness({ options: { resolution: "1080p", quality: "high" } }), "stale");
  assert.equal(freshness({ renderRevision: "revision-b" }), "stale");
  assert.equal(freshness({ clips: [{ id: 0, start: 60, end: 90, cover: 0 },
    { id: 1, start: 10.25, end: 50.25, cover: 12.5 }] }), "stale");
  assert.equal(freshness({ clips: [{ id: 1, start: 10.25, end: 50.25, cover: 12.5 }] }), "stale");
  assert.equal(freshness({ clips: [{ id: 1, start: 10, end: 50.25, cover: 12.5 },
    { id: 0, start: 60, end: 90, cover: 0 }] }), "stale");
  assert.equal(freshness({ clips: [{ id: 1, start: 10.25, end: 50.25, cover: 12.6 },
    { id: 0, start: 60, end: 90, cover: 0 }] }), "stale");
});

test("millisecond roundoff is tolerated but real changes are not", () => {
  assert.equal(freshness({ clips: [{ id: 1, start: 10.2504, end: 50.2496, cover: 12.5004 },
    { id: 0, start: 60, end: 90, cover: 0 }] }), "fresh");
  assert.equal(freshness({ clips: [{ id: 1, start: 10.2506, end: 50.25, cover: 12.5 },
    { id: 0, start: 60, end: 90, cover: 0 }] }), "stale");
  assert.equal(freshness({ clips: [{ id: 1, start: Number.NaN, end: 50.25, cover: 12.5 },
    { id: 0, start: 60, end: 90, cover: 0 }] }), "stale");
});

test("preview-only format changes do not make prepared exports stale", () => {
  assert.equal(freshness({ previewAspect: "1:1" }), "fresh");
  assert.equal(freshness({ previewAspect: "4:5" }), "fresh");
});

test("legacy results without a request snapshot are unknown, not silently fresh", () => {
  assert.equal(clipExportFreshness({ ...result, clip_request: undefined }, input), "unknown");
  assert.equal(freshness({ renderRevision: undefined }), "unknown");
});

test("a legacy single-format snapshot is fresh only for that one format", () => {
  const legacy = { ...result, clip_request: { ...result.clip_request, aspect_ratios: undefined } };
  assert.equal(clipExportFreshness(legacy, { ...input, aspects: ["4:5"] }), "fresh");
  assert.equal(clipExportFreshness(legacy, input), "stale");
  assert.equal(clipExportFreshness({ ...result,
    clip_request: { ...result.clip_request, aspect_ratios: undefined, aspect_ratio: undefined } }, input), "unknown");
});

function verified() {
  return { ...result, clip_request: { ...result.clip_request, source_sha256: "a".repeat(64) },
    outputs: [1, 2].flatMap(clip_index => ["4:5", "1:1"].map(aspect_ratio => ({
      clip_index, aspect_ratio, output: `${clip_index}-${aspect_ratio}.mp4`, thumbnail: `${clip_index}-${aspect_ratio}.jpg`,
      sha256: "b".repeat(64), thumbnail_sha256: "c".repeat(64),
    }))) };
}

test("per-clip freshness isolates trim changes and identifies cover-only work", () => {
  const r = verified();
  assert.equal(clipExportItemFreshness(r, input, input.clips[0]), "fresh");
  assert.equal(clipExportItemFreshness(r, input, { ...input.clips[0], start: 11 }), "stale");
  assert.equal(clipExportItemFreshness(r, input, { ...input.clips[0], cover: 13 }), "cover");
  assert.equal(clipExportItemFreshness(r, input, input.clips[1]), "fresh");
  assert.equal(clipExportItemFreshness(r, input, { ...input.clips[0], start: NaN }), "stale");
});

test("global render input changes make each clip stale", () => {
  for (const patch of [{ analysisId: "other" }, { renderRevision: "other" }, { fill: "fit" },
    { options: { resolution: "720p", quality: "standard" } }, { options: { resolution: "1080p", quality: "fast" } }]) {
    assert.equal(clipExportItemFreshness(verified(), { ...input, ...patch }, input.clips[0]), "stale");
  }
});

test("item freshness ignores ordering and allows subsets, but detects new clips/formats", () => {
  const r = verified();
  assert.equal(clipExportItemFreshness(r, { ...input, clips: [...input.clips].reverse(), aspects: ["1:1", "4:5"] }, input.clips[0]), "fresh");
  assert.equal(clipExportItemFreshness(r, { ...input, aspects: ["1:1"] }, input.clips[0]), "fresh");
  assert.equal(clipExportItemFreshness(r, { ...input, aspects: ["1:1", "9:16"] }, input.clips[0]), "stale");
  assert.equal(clipExportItemFreshness(r, input, { ...input.clips[0], id: 99 }), "stale");
});

test("legacy or missing hash/association metadata stays unknown", () => {
  for (const mutate of [r => { delete r.clip_request; }, r => { delete r.clip_request.source_sha256; },
    r => { r.outputs.forEach(o => delete o.clip_index); }, r => { delete r.outputs[0].sha256; },
    r => { r.outputs[0].thumbnail = ""; }]) {
    const r = verified(); mutate(r);
    assert.equal(clipExportItemFreshness(r, input, input.clips[0]), "unknown");
  }
  assert.equal(clipExportItemFreshness(verified(), { ...input, renderRevision: undefined }, input.clips[0]), "unknown");
});

test("a missing or stale thumbnail hash predicts only a cover refresh", () => {
  const missing = verified(); delete missing.outputs[0].thumbnail_sha256;
  assert.equal(clipExportItemFreshness(missing, input, input.clips[0]), "cover");
  const invalid = verified(); invalid.outputs[0].thumbnail_sha256 = "invalid";
  assert.equal(clipExportItemFreshness(invalid, input, input.clips[0]), "cover");
  // The same thumbnail problem with unchanged cover timing is still only a JPG refresh.
  const sameCover = verified(); sameCover.outputs[0].thumbnail_sha256 = null;
  assert.equal(clipExportItemFreshness(sameCover, input, input.clips[0]), "cover");
});

test("ambiguous records are unknown while missing requested pairs are stale", () => {
  const duplicates = verified(); duplicates.outputs.push({ ...duplicates.outputs[0] });
  assert.equal(clipExportItemFreshness(duplicates, input, input.clips[0]), "unknown");
  const missing = verified(); missing.outputs.shift();
  assert.equal(clipExportItemFreshness(missing, input, input.clips[0]), "stale");
  const clips = verified(); clips.clip_request = { ...clips.clip_request,
    clips: [...clips.clip_request.clips, { ...clips.clip_request.clips[0] }] };
  assert.equal(clipExportItemFreshness(clips, input, input.clips[0]), "unknown");
});

test("per-clip roundoff tolerance matches batch freshness without mutating inputs", () => {
  const r = verified(); const before = JSON.stringify(r);
  assert.equal(clipExportItemFreshness(r, input, { ...input.clips[0], start: 10.2504 }), "fresh");
  assert.equal(clipExportItemFreshness(r, input, { ...input.clips[0], start: 10.2506 }), "stale");
  assert.equal(JSON.stringify(r), before);
});
