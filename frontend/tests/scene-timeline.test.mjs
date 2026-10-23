import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual pure TS helpers using the project's existing compiler.
const source = fs.readFileSync(new URL("../lib/scene-timeline.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { reorderScenes, sceneLayout, sceneBounds, transitionOverlap, timelineDuration } = exported;
const scene = (id, duration = 4) => ({ id, duration, trim_start: 0, trim_end: null });

test("drag moves before/after target without losing scenes or mutating the input", () => {
  const scenes = [scene("a"), scene("b"), scene("c")];
  const ids = (values) => Array.from(values, (s) => s.id);
  assert.deepEqual(ids(reorderScenes(scenes, "a", "c", "after")), ["b", "c", "a"]);
  assert.deepEqual(ids(reorderScenes(scenes, "c", "a", "before")), ["c", "a", "b"]);
  assert.deepEqual(ids(scenes), ["a", "b", "c"]);
});

test("invalid external drag and dropping on self do nothing", () => {
  const scenes = [scene("a"), scene("b")];
  assert.equal(reorderScenes(scenes, "external", "a", "before"), scenes);
  assert.equal(reorderScenes(scenes, "a", "a", "after"), scenes);
});

test("layout uses actual generated duration and unsaved trim values", () => {
  const draft = [{ ...scene("a"), trim_start: 1, trim_end: 3 }, scene("b")];
  const runtime = [{ ...scene("a"), actual_duration: 8 }, { ...scene("b"), actual_duration: 5 }];
  const layout = sceneLayout(draft, runtime);
  assert.equal(layout[0].length, 2);
  assert.equal(layout[1].offset, 2);
  assert.equal(layout[1].length, 5);
});

test("preview bounds stay inside media with at least a quarter second", () => {
  const bounds = sceneBounds({ ...scene("a"), trim_start: 20, trim_end: 2 }, { actual_duration: 4 });
  assert.equal(bounds.start, 3.75);
  assert.equal(bounds.end, 4);
  assert.equal(bounds.length, 0.25);
});

test("transitions overlap neighbours and shorten offsets and the total", () => {
  const draft = [
    { ...scene("a"), transition: "cut", transition_duration: 0.6 },
    { ...scene("b"), transition: "dissolve", transition_duration: 0.5 },
    { ...scene("c"), transition: "fade", transition_duration: 6 },
  ];
  const runtime = draft.map((item) => ({ ...item, actual_duration: 4 }));
  const layout = sceneLayout(draft, runtime);
  assert.equal(layout[0].offset, 0);
  assert.equal(layout[1].offset, 3.5);
  assert.equal(layout[1].incoming, 0.5);
  assert.equal(layout[2].offset, 5.9); // 1.6s capped by 40% of the shorter scene.
  assert.equal(timelineDuration(layout), 9.9);
  assert.ok(Math.abs(layout.reduce((sum, item) => sum + item.weight, 0) - 9.9) < 1e-9);
});

test("overlap is disabled for cuts and scenes too short to blend", () => {
  assert.equal(transitionOverlap(4, 4, { transition: "cut", transition_duration: 2 }), 0);
  assert.equal(transitionOverlap(0.4, 4, { transition: "dissolve", transition_duration: 2 }), 0);
  assert.equal(transitionOverlap(4, 4, { transition: "dissolve", transition_duration: 0.5 }), 0.5);
  assert.equal(transitionOverlap(4, 4, { transition: "fade", transition_duration: 9 }), 1.6);
});
