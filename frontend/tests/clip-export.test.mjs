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
const { clipExportFreshness } = load("../lib/clip-export.ts");

const result = {
  archive: "/archive.zip",
  outputs: [],
  clip_request: {
    analysis_id: "abcdef123456",
    clips: [
      { id: 1, start: 10.25, end: 50.25, cover_at: 12.5 },
      { id: 0, start: 60, end: 90, cover_at: 0 },
    ],
    aspect_ratio: "4:5",
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
  aspect: "4:5",
  fill: "crop",
  options: { resolution: "1080p", quality: "standard" },
  renderRevision: "revision-a",
};
const freshness = (patch = {}) => clipExportFreshness(result, { ...input, ...patch });

test("fresh only when ordered clips, ranges, covers, format and render inputs all match", () => {
  assert.equal(freshness(), "fresh");
  assert.equal(freshness({ analysisId: "ffffffffffff" }), "stale");
  assert.equal(freshness({ aspect: "9:16" }), "stale");
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

test("legacy results without a request snapshot are unknown, not silently fresh", () => {
  assert.equal(clipExportFreshness({ ...result, clip_request: undefined }, input), "unknown");
  assert.equal(freshness({ renderRevision: undefined }), "unknown");
});
