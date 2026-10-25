import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
  const exported = {};
  vm.runInNewContext(js, { exports: exported, require: (name) => dependencies[name] });
  return exported;
}
const trim = load("../lib/clip-trim.ts");
const { clipRangeHistoryReducer: reduce, emptyClipRangeHistory, canUndoClipRanges, canRedoClipRanges,
  CLIP_HISTORY_LIMIT } = load("../lib/clip-range-history.ts", { "./clip-trim": trim });
const plain = (value) => JSON.parse(JSON.stringify(value));
const baseline = { 0: { start: 10, end: 45 }, 1: { start: 50, end: 80 } };
const initial = () => reduce(emptyClipRangeHistory, { type: "reset", context: "source-analysis-a", ranges: structuredClone(baseline) });
const action = (type, ranges) => ({ type, ranges, context: "source-analysis-a", duration: 120 });
const moved = (start) => ({ ...structuredClone(baseline), 0: { start, end: start + 35 } });

test("many pointer previews produce one undo step on commit", () => {
  let state = initial();
  for (let start = 11; start <= 20; start++) state = reduce(state, action("preview", moved(start)));
  assert.equal(state.past.length, 0);
  state = reduce(state, action("commit", moved(20)));
  assert.equal(state.past.length, 1);
  assert.equal(canUndoClipRanges(state), true);
  state = reduce(state, action("undo"));
  assert.deepEqual(plain(state.present), baseline);
  assert.equal(canRedoClipRanges(state), true);
  state = reduce(state, action("redo"));
  assert.deepEqual(plain(state.present), moved(20));
});

test("cancelled gesture restores preview and adds no history or lost redo", () => {
  let state = reduce(initial(), action("commit", moved(20)));
  state = reduce(state, action("undo"));
  state = reduce(state, action("preview", moved(15)));
  assert.equal(canRedoClipRanges(state), false);
  state = reduce(state, action("preview", structuredClone(baseline)));
  assert.equal(state.past.length, 0);
  assert.equal(canUndoClipRanges(state), false);
  assert.equal(canRedoClipRanges(state), true);
});

test("no-op commits preserve redo while a new valid change clears it", () => {
  let state = reduce(initial(), action("commit", moved(20)));
  state = reduce(state, action("undo"));
  state = reduce(state, action("commit", structuredClone(baseline)));
  assert.equal(state.future.length, 1);
  state = reduce(state, action("commit", moved(15)));
  assert.equal(state.future.length, 0);
  assert.equal(state.past.length, 1);
});

test("invalid numeric input is not committed; undo first discards unfinished input", () => {
  let state = reduce(initial(), action("commit", moved(20)));
  state = reduce(state, action("commit", moved(-10)));
  assert.equal(state.committed[0].start, 20);
  assert.equal(state.past.length, 1);
  assert.equal(canRedoClipRanges(state), false);
  state = reduce(state, action("undo"));
  assert.equal(state.present[0].start, 20);
  assert.equal(state.past.length, 1);
  state = reduce(state, action("undo"));
  assert.equal(state.present[0].start, 10);
});

test("nonfinite invalid previews can be discarded without entering history", () => {
  let state = initial();
  state = reduce(state, action("preview", moved(NaN)));
  assert.equal(canUndoClipRanges(state), true);
  state = reduce(state, action("undo"));
  assert.deepEqual(plain(state.present), baseline);
  assert.equal(state.future.length, 0);
});

test("history is limited to 30 committed steps with bounded redo", () => {
  let state = initial();
  for (let i = 1; i <= 40; i++) state = reduce(state, action("commit", moved(10 + i / 10)));
  assert.equal(state.past.length, CLIP_HISTORY_LIMIT);
  for (let i = 0; i < 50; i++) state = reduce(state, action("undo"));
  assert.equal(state.present[0].start, 11);
  assert.equal(state.future.length, CLIP_HISTORY_LIMIT);
  for (let i = 0; i < 50; i++) state = reduce(state, action("redo"));
  assert.equal(state.present[0].start, 14);
  assert.equal(state.past.length, CLIP_HISTORY_LIMIT);
});

test("hydration/reset clears history and rejects queued actions for the old source or analysis", () => {
  let state = reduce(initial(), action("commit", moved(20)));
  const restored = moved(25);
  state = reduce(state, { type: "reset", context: "source-analysis-b", ranges: restored });
  assert.equal(canUndoClipRanges(state), false);
  assert.equal(canRedoClipRanges(state), false);
  assert.equal(reduce(state, action("commit", moved(30))), state);
  assert.equal(reduce(state, action("undo")), state);
  assert.deepEqual(plain(state.present), restored);
});

test("functional commits preserve other clips and never mutate old snapshots", () => {
  const before = initial();
  const state = reduce(before, action("commit", (ranges) => ({ ...ranges, 1: { start: 55, end: 85 } })));
  assert.deepEqual(plain(before.present), baseline);
  assert.deepEqual(plain(state.present[0]), baseline[0]);
  assert.equal(state.present[1].start, 55);
  assert.deepEqual(plain(reduce(state, action("undo")).present), baseline);
});

test("missing, forged or invalid ranges never become committed history", () => {
  const bad = [{ 0: baseline[0] }, { ...baseline, 99: baseline[0] },
    { ...baseline, 0: { start: 20, end: 21 } }, { ...baseline, 0: { start: 100, end: 140 } }];
  for (const ranges of bad) {
    const state = reduce(initial(), action("commit", ranges));
    assert.equal(state.past.length, 0);
    assert.deepEqual(plain(state.committed), baseline);
  }
});
