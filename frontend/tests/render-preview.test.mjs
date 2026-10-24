import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/render-preview.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { previewRange, previewIsStale } = exported;

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
