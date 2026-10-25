import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const exported = {};
const source = fs.readFileSync(new URL("../lib/clip-preview.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017,
} }).outputText, { exports: exported });
const { clipPreviewWindow, clipPreviewSelection, clipPreviewIsStale } = exported;
const range = { start: 40, end: 75 };
const options = { resolution: "720p", quality: "high" };
const result = { ...options, clip_id: 0, clip_start: 40, clip_end: 75, start: 73, end: 75,
  duration: 2, preview_start: 33, requested_duration: 10, fill: "crop", render_revision: "rev" };

test("clip-relative windows map to source time and clamp only the end", () => {
  const w = clipPreviewWindow(range, { start: 33, duration: 10 });
  assert.equal(w.valid, true);
  assert.equal(w.duration, 2);
  assert.equal(w.sourceStart, 73);
  assert.equal(w.sourceEnd, 75);
  assert.equal(w.maxStart, 34.9);
  assert.equal(clipPreviewWindow(range, { start: 20, duration: 5 }).duration, 5);
  assert.equal(clipPreviewWindow(range, { start: 20, duration: 10 }).duration, 10);
});

test("invalid starts are rejected rather than silently moved", () => {
  for (const start of [-1, NaN, Infinity, 35, 34.95])
    assert.equal(clipPreviewWindow(range, { start, duration: 5 }).valid, false);
  assert.equal(clipPreviewWindow(range, { start: 34.9, duration: 5 }).valid, true);
  assert.equal(clipPreviewWindow({ start: 0, end: 30.3 }, { start: 30.2, duration: 5 }).valid, true);
  assert.equal(clipPreviewWindow({ start: 0, end: NaN }, { start: 0, duration: 5 }).maxStart, 0);
});

test("old results recover zero/5 or zero/10 and new tail results keep requested length", () => {
  assert.equal(clipPreviewSelection().start, 0);
  assert.equal(clipPreviewSelection({ duration: 5 }).duration, 5);
  assert.equal(clipPreviewSelection({ duration: 10 }).duration, 10);
  assert.equal(clipPreviewSelection(result).start, 33);
  assert.equal(clipPreviewSelection(result).duration, 10);
});

test("staleness includes window selection, full range, style and source revision", () => {
  const selection = { start: 33, duration: 10 };
  const stale = (r = range, s = selection, o = options, f = "crop", rev = "rev") =>
    clipPreviewIsStale(result, r, s, o, f, rev);
  assert.equal(stale(), false);
  assert.equal(stale(range, { ...selection, start: 32 }), true);
  assert.equal(stale(range, { ...selection, duration: 5 }), true); // Both render 2s; request still changed.
  assert.equal(stale({ ...range, start: 41 }), true);
  assert.equal(clipPreviewIsStale(result, undefined, selection, options, "crop", "rev"), true);
  assert.equal(stale(range, selection, { ...options, quality: "fast" }), true);
  assert.equal(stale(range, selection, { ...options, resolution: "1080p" }), true);
  assert.equal(stale(range, selection, options, "fit"), true);
  assert.equal(stale(range, selection, options, "crop", "new-rev"), true);
});
