import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/layer-timeline.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { timelineLayers, adjustLayer, visibleLayer, layerTimingError, sourceToOutput, outputToSource } = exported;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("layer indices refer to the full plan, not the filtered track list", () => {
  const ops = [{ type: "speed", factor: 2 }, { type: "text", text: "Title", start: 1, duration: 2 }, { type: "music", track: "music" }, { type: "overlay", track: "image", start: 4, duration: 1 }];
  assert.deepEqual(plain(timelineLayers(ops)).map((layer) => layer.index), [1, 3]);
  assert.equal(ops[1].start, 1);
});
test("move and both resize handles clamp to output bounds and preserve the opposite edge", () => {
  const layer = { index: 2, start: 2, duration: 3 };
  assert.deepEqual(plain(adjustLayer(layer, "move", -10, 8)), { index: 2, start: 0, duration: 3 });
  assert.deepEqual(plain(adjustLayer(layer, "move", 20, 8)), { index: 2, start: 5, duration: 3 });
  assert.deepEqual(plain(adjustLayer(layer, "start", 1, 8)), { index: 2, start: 3, duration: 2 });
  assert.deepEqual(plain(adjustLayer(layer, "end", 1, 8)), { index: 2, start: 2, duration: 4 });
  assert.equal(adjustLayer(layer, "start", 20, 8).duration, 0.1);
  assert.equal(adjustLayer(layer, "end", -20, 8).duration, 0.1);
  assert.equal(layer.start, 2);
});
test("visual clipping never changes saved timing or extends width past the timeline", () => {
  const layer = { index: 0, start: 7, duration: 4 };
  assert.deepEqual(plain(visibleLayer(layer, 8)), { left: 87.5, width: 12.5 });
  assert.equal(visibleLayer({ ...layer, start: 9 }, 8), null);
  assert.ok(layerTimingError([layer], 8));
  assert.ok(layerTimingError([{ ...layer, start: NaN }], 8));
  assert.equal(layerTimingError([{ ...layer, start: 1, duration: 2 }], 8), null);
});
test("source/output mapping accounts for cuts, speed and ambiguous crossfade time", () => {
  const timeline = { source_duration: 10, segments: [[0, 2], [4, 10]], speed: 2, crossfade: 0.5, output_duration: 3.75 };
  assert.equal(sourceToOutput(3, timeline), null);
  assert.equal(sourceToOutput(5, timeline), 1.25);
  assert.equal(outputToSource(1.25, timeline), 5);
  assert.equal(outputToSource(0.8, timeline), 1.6); // Outgoing source during crossfade.
  assert.equal(outputToSource(4, timeline), null);
  assert.equal(sourceToOutput(NaN, timeline), null);
});
test("subsecond keyboard adjustments do not accumulate floating point drift", () => {
  let layer = { index: 0, start: 1, duration: 2 };
  for (let i = 0; i < 10; i++) layer = adjustLayer(layer, "move", 0.01, 6);
  assert.equal(layer.start, 1.1);
  assert.equal(layer.duration, 2);
});
test("exact rather than display-rounded duration bounds fractional-speed timelines", () => {
  const timeline = { source_duration: 8, segments: [[0, 8]], speed: 3, crossfade: 0, output_duration: 2.667, exact_output_duration: 8 / 3 };
  assert.equal(sourceToOutput(8, timeline), 8 / 3);
  assert.equal(outputToSource(2.6668, timeline), null);
  assert.equal(layerTimingError([adjustLayer({ index: 0, start: 0, duration: 1 }, "move", 10, timeline.exact_output_duration)], timeline.exact_output_duration), null);
});
