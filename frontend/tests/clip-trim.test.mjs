import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/clip-trim.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { nearestBoundary, clipRangeError, clampClipRange, snapClipEdge, constrainClipEdge, moveClipRange } = exported;
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

test("moving a whole clip preserves length at both source and frozen-window bounds", () => {
  const base = { start: 20, end: 55 };
  assert.deepEqual(plain(moveClipRange(base, 5, 100)), { start: 25, end: 60 });
  assert.deepEqual(plain(moveClipRange(base, -99, 100)), { start: 0, end: 35 });
  assert.deepEqual(plain(moveClipRange(base, 99, 100)), { start: 65, end: 100 });
  assert.deepEqual(plain(moveClipRange(base, -99, 100, 10, 70)), { start: 10, end: 45 });
  assert.deepEqual(plain(moveClipRange(base, 99, 100, 10, 70)), { start: 35, end: 70 });
  assert.deepEqual(plain(base), { start: 20, end: 55 });
  assert.deepEqual(plain(moveClipRange(base, 1, 100, 30, 50)), base);
});

test("whole-range movement rejects invalid drafts and nonfinite inputs without silently resizing", () => {
  for (const range of [{ start: -1, end: 40 }, { start: 10, end: 20 },
    { start: 10, end: 80 }, { start: 50, end: 40 }, { start: 0, end: NaN }]) {
    assert.equal(moveClipRange(range, 1, 100), range);
  }
  const base = { start: 10, end: 40 };
  assert.equal(moveClipRange(base, Infinity, 100), base);
  assert.equal(moveClipRange(base, NaN, 100), base);
  assert.equal(moveClipRange(base, 1, NaN), base);
  assert.deepEqual(plain(moveClipRange({ start: 0, end: 30 }, 20, 30)), { start: 0, end: 30 });
});

test("whole-range fractional movement preserves duration and relative keyboard precision", () => {
  let range = { start: 32.85, end: 67.85 };
  for (let i = 0; i < 100; i++) range = moveClipRange(range, 0.1, 120);
  assert.ok(Math.abs(range.start - 42.85) < 1e-9);
  assert.ok(Math.abs(range.end - range.start - 35) < 1e-9);
  for (const duration of [80, 80.035, 120]) {
    for (const delta of [-100, -0.1, 0, 0.1, 100]) {
      const shifted = moveClipRange({ start: 10.025, end: 40.025 }, delta, duration);
      assert.equal(clipRangeError(shifted, duration), null);
      assert.ok(Math.abs(shifted.end - shifted.start - 30) < 1e-9);
    }
  }
});
