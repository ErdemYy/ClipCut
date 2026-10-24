import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/transcript-edit.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { transcriptSelection, toggleTranscriptRow } = exported;
const rows = [{ id: 3, start: 0, end: 2 }, { id: 1, start: 3, end: 5 }, { id: 8, start: 6, end: 9 }];

test("selection follows transcript order, not ID order; source gaps remain in clip", () => {
  const selection = transcriptSelection(rows, [8, 1]);
  assert.equal(selection.contiguous, true);
  assert.equal(selection.start, 3);
  assert.equal(selection.end, 9);
});
test("disjoint rows can be cut but cannot make one contiguous clip", () => {
  assert.equal(transcriptSelection(rows, [3, 8]).contiguous, false);
  assert.equal(transcriptSelection(rows, []).contiguous, false);
  assert.equal(transcriptSelection(rows, [1]).contiguous, true);
});
test("checkbox toggle is immutable and ignores unknown IDs in summaries", () => {
  const ids = [3];
  assert.deepEqual(Array.from(toggleTranscriptRow(ids, 8)), [3, 8]);
  assert.deepEqual(Array.from(toggleTranscriptRow(ids, 3)), []);
  assert.deepEqual(ids, [3]);
  assert.equal(transcriptSelection(rows, [999]).rows.length, 0);
});
