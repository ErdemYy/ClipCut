import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017,
  } }).outputText;
  const exported = {};
  vm.runInNewContext(js, { exports: exported, require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  } });
  return exported;
}
const trim = load("../lib/clip-trim.ts");
const cover = load("../lib/clip-cover.ts");
const { clipDraftStorageKey, clipDraftContext, defaultClipDraft, readClipDraft, serializeClipDraft } =
  load("../lib/clip-draft.ts", { "./clip-trim": trim, "./clip-cover": cover });
const clips = [{ id: 0, start: 10, end: 45 }, { id: 1, start: 50, end: 80 }];
const context = clipDraftContext("project-a", "/source.mp4", 100, true, "analysis-a", clips);
const plain = (value) => JSON.parse(JSON.stringify(value));
const snapshot = () => {
  const draft = defaultClipDraft(clips);
  draft.ranges[0] = { start: 12.85, end: 47.85 };
  draft.selected = [1, 0]; draft.options = { resolution: "720p", quality: "high" };
  draft.fill = "crop"; draft.snap = false;
  draft.covers[0] = 12.5;
  return draft;
};

test("draft roundtrip preserves precise ranges, ordered selection and output settings", () => {
  const draft = snapshot();
  const raw = serializeClipDraft(draft, context, clips, 100);
  assert.deepEqual(plain(readClipDraft(raw, context, clips, 100)), plain(draft));
  assert.notEqual(clipDraftStorageKey("project-a"), clipDraftStorageKey("project-b"));
});

test("source, analysis, project, duration and candidate changes reject stale snapshots", () => {
  const raw = serializeClipDraft(snapshot(), context, clips, 100);
  const contexts = [
    clipDraftContext("project-b", "/source.mp4", 100, true, "analysis-a", clips),
    clipDraftContext("project-a", "/new.mp4", 100, true, "analysis-a", clips),
    clipDraftContext("project-a", "/source.mp4", 99, true, "analysis-a", clips),
    clipDraftContext("project-a", "/source.mp4", 100, false, "analysis-a", clips),
    clipDraftContext("project-a", "/source.mp4", 100, true, "analysis-b", clips),
    clipDraftContext("project-a", "/source.mp4", 100, true, "analysis-a", [{ ...clips[0], start: 11 }, clips[1]]),
  ];
  for (const changed of contexts) assert.equal(readClipDraft(raw, changed, clips, 100), null);
});

test("corrupt, oversized and unsupported snapshots fail closed", () => {
  for (const raw of [null, "", "{broken", "null", "[]", "x".repeat(64001),
    JSON.stringify({ version: 2, context, draft: snapshot() })]) {
    assert.equal(readClipDraft(raw, context, clips, 100), null);
  }
});

test("invalid ranges, unknown or duplicate selections and forged output settings are rejected", () => {
  const mutations = [
    (d) => { d.ranges[0].start = -1; }, (d) => { d.ranges[0].end = 15; },
    (d) => { d.ranges[0].end = 101; }, (d) => { d.ranges[0].start = NaN; },
    (d) => { delete d.ranges[1]; }, (d) => { d.ranges[99] = { start: 0, end: 30 }; },
    (d) => { d.selected = [99]; }, (d) => { d.selected = [0, 0]; },
    (d) => { d.selected = ["0"]; }, (d) => { d.fill = "stretch"; },
    (d) => { d.options.resolution = "8k"; }, (d) => { d.options.quality = "ultra"; },
    (d) => { d.snap = "false"; },
  ];
  for (const mutate of mutations) {
    const draft = snapshot(); mutate(draft);
    assert.equal(serializeClipDraft(draft, context, clips, 100), null);
  }
});

test("reset defaults are fresh objects and do not mutate candidates", () => {
  const a = defaultClipDraft(clips); const b = defaultClipDraft(clips);
  a.ranges[0].start = 20; a.selected.push(0); a.options.quality = "high";
  assert.equal(b.ranges[0].start, 10);
  assert.equal(b.selected.length, 0);
  assert.equal(b.options.quality, "standard");
  assert.equal(clips[0].start, 10);
});

test("legacy drafts without covers migrate without losing existing ranges or selections", () => {
  const draft = snapshot();
  delete draft.covers;
  const restored = readClipDraft(JSON.stringify({ version: 1, context, draft }), context, clips, 100);
  assert.deepEqual(plain(restored.covers), { 0: 0, 1: 0 });
  assert.deepEqual(plain(restored.selected), [1, 0]);
  assert.equal(restored.ranges[0].start, 12.85);
});

test("covers persist precisely and reject stale, nonfinite or forged per-clip values", () => {
  const draft = snapshot();
  draft.covers[0] = 34.9;
  assert.equal(readClipDraft(serializeClipDraft(draft, context, clips, 100), context, clips, 100).covers[0], 34.9);
  for (const covers of [{ 0: -1, 1: 0 }, { 0: 35, 1: 0 }, { 0: NaN, 1: 0 }, { 0: 0 },
    { 0: 0, 99: 0 }, { 0: "1", 1: 0 }, null, [0, 0]]) {
    assert.equal(serializeClipDraft({ ...draft, covers }, context, clips, 100), null);
  }
});

test("shortening a clip does not silently move a cover beyond its new end", () => {
  const draft = snapshot();
  draft.covers[0] = 32;
  draft.ranges[0] = { start: 10, end: 40 };
  assert.equal(serializeClipDraft(draft, context, clips, 100), null);
  draft.covers[0] = 29.9;
  assert.ok(serializeClipDraft(draft, context, clips, 100));
});

test("cover bounds use clip-relative time and tolerate fractional boundary roundoff only", () => {
  assert.equal(cover.clipCoverMax({ start: 40, end: 75 }), 34.9);
  assert.equal(cover.clipCoverError(34.9, { start: 40, end: 75 }), null);
  assert.ok(cover.clipCoverError(35, { start: 40, end: 75 }));
  assert.ok(cover.clipCoverError(Infinity, { start: 40, end: 75 }));
  assert.equal(cover.clipCoverError(30.2, { start: 0, end: 30.3 }), null);
  assert.ok(cover.clipCoverError(30.20001, { start: 0, end: 30.3 }));
});
