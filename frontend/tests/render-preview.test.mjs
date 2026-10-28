import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/render-preview.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { previewRange, previewIsStale, mainRenderFreshness, mainRenderMessage } = exported;

test("preview selection clamps to edited output and clips the short tail", () => {
  const range = previewRange(8, 5, 10);
  assert.equal(range.start, 8);
  assert.equal(range.end, 10);
  assert.equal(previewRange(0, 5, 0.8).end, 0.8);
  assert.equal(previewRange(30, 10, 10).start, 9.9);
});

test("empty, negative and nonfinite selections are safe", () => {
  assert.equal(previewRange(-2, 5, 10).start, 0);
  assert.equal(previewRange(NaN, 5, 10).start, 0);
  assert.equal(previewRange(5, 5, 0).start, 0);
});

test("recovered result is stale after edits or rendering-setting changes", () => {
  const options = { resolution: "1080p", quality: "standard" };
  const result = { ...options, render_revision: "old" };
  assert.equal(previewIsStale(result, "old", options), false);
  assert.equal(previewIsStale(result, "new", options), true);
  assert.equal(previewIsStale(result, undefined, options), true);
  assert.equal(previewIsStale(result, "old", { ...options, resolution: "720p" }), true);
  assert.equal(previewIsStale(result, "old", { ...options, quality: "high" }), true);
});

test("main render freshness compares the rendered snapshot, not completion time", () => {
  const a = "a".repeat(64), b = "b".repeat(64);
  const project = { output_url: "/media/output.mp4", render_revision: a,
    output_meta: { render_revision: a, rendered_at: "2026-10-28" } };
  const before = JSON.stringify(project);
  assert.equal(mainRenderFreshness(project), "fresh");
  assert.equal(mainRenderFreshness({ ...project, render_revision: b }), "stale");
  assert.match(mainRenderMessage({ ...project, render_revision: b }), /mevcut düzenlemeleri içermiyor/);
  assert.match(mainRenderMessage({ ...project, render_revision: b }), /MP4 indirilebilir/);
  assert.equal(mainRenderFreshness(project), "fresh"); // Reverting inputs recovers freshness.
  assert.equal(JSON.stringify(project), before);
});

test("legacy, missing or malformed revision metadata never claims a current output", () => {
  const project = { output_url: "/output.mp4", render_revision: "a".repeat(64) };
  for (const output_meta of [undefined, null, {}, { render_revision: "legacy" }]) {
    assert.equal(mainRenderFreshness({ ...project, output_meta }), "unknown");
    assert.match(mainRenderMessage({ ...project, output_meta }), /doğrulanamıyor/);
  }
  assert.equal(mainRenderFreshness({ ...project, output_url: null }), "missing");
  assert.equal(mainRenderMessage({ ...project, output_url: null }), null);
});

test("product UI avoids demo wording without disguising synthetic test outputs", () => {
  for (const file of ["../components/Navbar.tsx", "../app/page.tsx", "../components/StoryboardForm.tsx",
    "../components/editor/GenerationCost.tsx", "../components/editor/SubtitleTimingEditor.tsx",
    "../components/editor/TranscriptPanel.tsx", "../components/editor/StoryboardPanel.tsx"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /demo/i, file);
  }
  const form = fs.readFileSync(new URL("../components/StoryboardForm.tsx", import.meta.url), "utf8");
  assert.match(form, /Test sağlayıcısı/);
  assert.match(form, /gerçek konuşma değil sentetik tondur/);
});
