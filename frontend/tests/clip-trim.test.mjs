import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/clip-trim.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { nearestBoundary, clipRangeError, clampClipRange, snapClipEdge, constrainClipEdge } = exported;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("clip range validation enforces source bounds and 30–60 seconds", () => {
  assert.equal(clipRangeError({ start: 10, end: 40 }, 120), null);
  assert.ok(clipRangeError({ start: -1, end: 40 }, 120));
  assert.ok(clipRangeError({ start: 100, end: 135 }, 120));
  assert.ok(clipRangeError({ start: 50, end: 40 }, 120));
  assert.ok(clipRangeError({ start: 0, end: 29.9 }, 120));
  assert.ok(clipRangeError({ start: 0, end: 60.1 }, 120));
  assert.ok(clipRangeError({ start: 0, end: Number.NaN }, 120));
  assert.equal(clipRangeError({ start: 0, end: 30 }, 120), null);
  assert.equal(clipRangeError({ start: 60, end: 120 }, 120), null);
});

test("out-of-bounds and nonfinite values clamp without hiding invalid order", () => {
  assert.deepEqual(plain(clampClipRange({ start: -4, end: 200 }, 120)), { start: 0, end: 120 });
  assert.deepEqual(plain(clampClipRange({ start: Number.NaN, end: Number.POSITIVE_INFINITY }, 120)),
    { start: 0, end: 120 });
  assert.equal(clampClipRange({ start: 90, end: 20 }, 120).start, 90);
});

test("sentence snapping chooses the nearest edge only when duration stays valid", () => {
  assert.equal(nearestBoundary(14, [10, 15, 20]), 15);
  assert.equal(nearestBoundary(18.2, [10, 20]), 20);
  assert.equal(snapClipEdge("start", 12.4, { start: 12.4, end: 50 }, [12, 20], 120), 12);
  assert.equal(snapClipEdge("end", 48.6, { start: 10, end: 48.6 }, [40, 50], 120), 50);
  assert.equal(snapClipEdge("start", 12.4, { start: 12.4, end: 35 }, [12, 20], 120), 12.4);
  assert.equal(snapClipEdge("end", 48.6, { start: 10, end: 48.6 }, [70, 80], 120), 48.6);
});

test("dragging a clip edge preserves duration, source and visible-window bounds", () => {
  const base = { start: 10, end: 40 };
  assert.deepEqual(plain(constrainClipEdge("start", 5, base, 100)), { start: 5, end: 40 });
  assert.deepEqual(plain(constrainClipEdge("start", 20, base, 100)), { start: 10, end: 40 });
  assert.deepEqual(plain(constrainClipEdge("start", -5, base, 100)), { start: 0, end: 40 });
  assert.deepEqual(plain(constrainClipEdge("end", 50, base, 100)), { start: 10, end: 50 });
  assert.deepEqual(plain(constrainClipEdge("end", 80, base, 100)), { start: 10, end: 70 });
  assert.deepEqual(plain(constrainClipEdge("end", 20, base, 100)), { start: 10, end: 40 });
  assert.deepEqual(plain(constrainClipEdge("end", 90, base, 100, 0, 50)), { start: 10, end: 50 });
  assert.deepEqual(plain(constrainClipEdge("start", 15, { start: 40, end: 100 }, 100)), { start: 40, end: 100 });
  assert.deepEqual(plain(constrainClipEdge("end", 120, { start: 0, end: 30 }, 30)), { start: 0, end: 30 });
});
