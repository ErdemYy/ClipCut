import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/subtitle-timing.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
const exported = {};
vm.runInNewContext(js, { exports: exported });
const { prepareSubtitleSegments, subtitleText, subtitleBounds, splitSubtitle, mergeSubtitle, shiftSubtitles, subtitleTimingError } = exported;
const rows = () => [{ id: 0, start: 1, end: 3, text: "Merhaba dünya", words: [
  { text: "Merhaba", start: 1, end: 1.6 }, { text: "dünya", start: 2, end: 3 },
] }, { id: 2, start: 4, end: 5, text: "Son", words: [{ text: "Son", start: 4, end: 5 }] }];

test("prepare preserves precise timing and supplies words only if missing or inconsistent", () => {
  const original = rows();
  const prepared = prepareSubtitleSegments(original);
  assert.equal(prepared[0].words[0].end, 1.6);
  assert.notEqual(prepared[0].words, original[0].words);
  const fallback = prepareSubtitleSegments([{ ...original[0], words: [] }]);
  assert.equal(fallback[0].words.length, 2);
  assert.equal(fallback[0].words[1].end, 3);
});
test("split then merge retains gaps and original word times without mutations", () => {
  const original = rows();
  const split = splitSubtitle(original, 0, 1);
  assert.equal(split.length, 3);
  assert.equal(split[0].end, 1.6);
  assert.equal(split[1].start, 2);
  assert.equal(split[1].id, 3);
  assert.equal(split[1].words[0].end, 3);
  const merged = mergeSubtitle(split, 0);
  assert.equal(JSON.stringify(merged), JSON.stringify(original));
  assert.equal(original.length, 2);
});
test("positive and negative shifts move every word equally; out-of-bounds fails atomically", () => {
  const original = rows();
  const shifted = shiftSubtitles(original, 0.25, 6);
  assert.equal(shifted[0].start, 1.25);
  assert.equal(shifted[0].words[1].end, 3.25);
  assert.equal(JSON.stringify(shiftSubtitles(shifted, -0.25, 6)), JSON.stringify(original));
  assert.throws(() => shiftSubtitles(original, -2, 6));
  assert.throws(() => shiftSubtitles(original, 2, 6));
  assert.throws(() => shiftSubtitles(original, NaN, 6));
  assert.equal(original[0].start, 1);
});
test("row bounds scale words and text edits redistribute only when tokens change", () => {
  const row = rows()[0];
  assert.equal(subtitleText(row, "  Merhaba dünya ").words[0].end, 1.6);
  const edited = subtitleText(row, "Yeni metin burada");
  assert.equal(edited.words.length, 3);
  assert.equal(edited.words[2].end, 3);
  const scaled = subtitleBounds(row, 2, 6);
  assert.equal(scaled.words[0].end, 3.2);
  assert.equal(scaled.words[1].start, 4);
  assert.equal(scaled.words[1].end, 6);
});
test("timing errors catch overlaps, reversed words and text mismatches", () => {
  assert.equal(subtitleTimingError(rows(), 6), null);
  const bad = rows();
  bad[0].words[1].start = 1.5;
  assert.match(subtitleTimingError(bad, 6), /kelime zamanları/);
  assert.ok(subtitleTimingError([{ ...rows()[0], end: 1 }], 6));
  assert.ok(subtitleTimingError([{ ...rows()[0], text: "Different" }], 6));
  assert.ok(subtitleTimingError([...rows(), rows()[0]], 6));
});
