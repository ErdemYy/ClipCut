import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(fs.readFileSync(new URL("../components/editor/PublishingControls.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const trim = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/clip-trim.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText, { exports: trim });
const history = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/clip-range-history.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText, { exports: history, require(name) {
  if (name === "./clip-trim") return trim;
  throw new Error(`Unexpected import ${name}`);
} });
const grouping = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/publishing-results.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText, { exports: grouping, require(name) {
  if (name === "./clip-trim") return trim;
  throw new Error(`Unexpected import ${name}`);
} });
const clipExport = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/clip-export.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText, { exports: clipExport });

function groupedJob() {
  const clips = [1, 2].map((clip_index) => ({ clip_index, start: clip_index * 30,
    end: clip_index * 30 + 30, archive: `clip-${clip_index}.zip` }));
  return { id: "group-job", status: "done", result: { archive: "group-all.zip", clip_archives: clips,
    format_archives: { "9:16": "group-portrait.zip", "1:1": "group-square.zip" },
    outputs: clips.flatMap(({ clip_index }) => ["9:16", "1:1"].map((aspect_ratio) => ({
      clip_index, aspect_ratio, label: `clip_${clip_index}_${aspect_ratio}`, width: 720, height: 720,
      duration: 30, output: `clip-${clip_index}-${aspect_ratio}.mp4`, thumbnail: "cover.jpg", thumbnail_fallback: false,
    }))) } };
}

// Exercise actual component handlers; browser media decoding is tested separately.
function harness() {
  const states = [];
  let cursor = 0;
  const ref = { current: 0 };
  const jsx = (type, props, key) => ({ type, props, key });
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) {
    if (name === "react") return {
      useId: () => ":preview:",
      useRef: () => ref,
      useState(value) {
        const index = cursor++;
        if (!(index in states)) states[index] = value;
        return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
    };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "next/image") return { default: "img" };
    if (name === "@/lib/publishing-results") return grouping;
    if (name === "@/lib/clip-export") return clipExport;
    if (name === "@/lib/api") return { mediaUrl: (s) => `media:${s}`, downloadUrl: (s) => `download:${s}`, formatTime: String };
    if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) };
    throw new Error(`Unexpected import ${name}`);
  } });
  const output = (name) => ({ label: `clip_01_${name}`, aspect_ratio: name === "square" ? "1:1" : "9:16", width: 720, height: 720,
    duration: 30, output: `${name}.mp4`, thumbnail: `${name}.jpg`, thumbnail_fallback: false });
  let job = { id: "job-a", status: "done", result: { archive: "all.zip", outputs: [output("square"), output("portrait")] } };
  let freshness;
  let clipEditors;
  let clipRangeRestorers;
  let clipFreshness;
  const nodes = (n) => !n || typeof n !== "object" ? []
    : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)];
  const render = () => { cursor = 0; return nodes(exports.PublishingResults({ job, freshness, clipEditors, clipRangeRestorers, clipFreshness })); };
  const buttons = () => render().filter(n => n.type === "button" && typeof n.props["aria-expanded"] === "boolean");
  return { render, buttons, videos: () => render().filter(n => n.type === "video"),
    filter: () => render().find(n => n.type === "select"),
    formats: () => render().filter(n => n.type === "button" && typeof n.props["aria-pressed"] === "boolean"),
    setClipEditors: (value) => { clipEditors = value; },
    setClipRangeRestorers: (value) => { clipRangeRestorers = value; },
    setClipFreshness: (value) => { clipFreshness = value; },
    setJob: (next) => { job = next; }, get job() { return job; }, setFreshness: (value) => { freshness = value; } };
}

test("results initially mount posters, not video sources, and keep every download", () => {
  const h = harness();
  assert.equal(h.videos().length, 0);
  assert.equal(h.render().filter(n => n.type === "img").length, 2);
  assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 5);
  for (const button of h.buttons()) {
    assert.equal(button.props["aria-expanded"], false);
    assert.ok(h.render().some(n => n.props?.id === button.props["aria-controls"] && n.props.hidden));
  }
});

test("opening and closing mount one inline video without autoplay", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  const video = h.videos()[0];
  assert.equal(h.videos().length, 1);
  assert.equal(video.props.src, "media:square.mp4");
  assert.equal(video.props.preload, "metadata");
  assert.equal(video.props.playsInline, true);
  assert.equal(video.props.controls, true);
  assert.equal(video.props.autoPlay, undefined);
  assert.equal(h.buttons()[0].props["aria-expanded"], true);
  h.buttons()[0].props.onClick();
  assert.equal(h.videos().length, 0);
});

test("switching output unmounts the previous player and ignores its late error", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  const oldVideo = h.videos()[0];
  h.buttons()[1].props.onClick(); oldVideo.props.onError();
  assert.equal(h.videos().length, 1);
  assert.equal(h.videos()[0].props.src, "media:portrait.mp4");
  assert.equal(h.buttons()[0].props["aria-expanded"], false);
});

test("reopening the same output ignores errors from the previous mount", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  const previous = h.videos()[0];
  h.buttons()[0].props.onClick(); h.buttons()[0].props.onClick();
  previous.props.onError();
  assert.equal(h.videos().length, 1);
  assert.notEqual(h.videos()[0].key, previous.key);
});

test("media failure exposes retry and downloads; retry remounts and ignores old events", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  const failed = h.videos()[0]; failed.props.onError();
  assert.equal(h.videos().length, 0);
  assert.ok(h.render().some(n => n.props?.role === "alert"));
  assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 5);
  h.render().find(n => n.type === "button" && n.props.children === "Oynatmayı yeniden dene").props.onClick();
  assert.equal(h.videos().length, 1);
  assert.notEqual(h.videos()[0].key, failed.key);
  failed.props.onError();
  assert.equal(h.videos().length, 1);
});

test("a new job or archive cannot reuse the previous active output", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  h.setJob({ ...h.job, id: "job-b" });
  assert.equal(h.videos().length, 0);
  h.buttons()[0].props.onClick();
  h.setJob({ ...h.job, result: { ...h.job.result, archive: "new.zip" } });
  assert.equal(h.videos().length, 0);
});

test("stale and legacy warnings coexist with playback without mutating results", () => {
  const h = harness(); const before = JSON.stringify(h.job);
  h.buttons()[0].props.onClick();
  for (const freshness of ["stale", "unknown"]) {
    h.setFreshness(freshness);
    const message = freshness === "stale" ? "son hazırlanan dosyalardan farklı" : "güncellik bilgisi olmadan";
    assert.ok(h.render().some(n => n.props?.role === "status"
      && typeof n.props.children === "string" && n.props.children.includes(message)));
    assert.equal(h.videos().length, 1);
  }
  assert.equal(JSON.stringify(h.job), before);
});

test("failed, unfinished and malformed jobs have no playback controls", () => {
  const h = harness();
  for (const job of [undefined, { status: "running" }, { status: "done", result: {} }, { status: "failed", error: "failed" }]) {
    h.setJob(job);
    assert.equal(h.videos().length, 0);
    assert.equal(h.buttons().length, 0);
  }
});

test("format filter counts outputs and preserves their order and the complete archive", () => {
  const h = harness();
  const first = h.job.result.outputs[0];
  h.setJob({ ...h.job, result: { ...h.job.result,
    outputs: [...h.job.result.outputs, { ...first, label: "clip_02_square", output: "square-2.mp4" }] } });
  const before = JSON.stringify(h.job);
  const values = h.render().filter(n => n.type === "option").map(n => n.props.value);
  assert.deepEqual(values, ["all", "1:1", "9:16"]);
  h.filter().props.onChange({ target: { value: "1:1" } });
  assert.equal(h.filter().props.value, "1:1");
  assert.deepEqual(h.render().filter(n => n.type === "strong").map(n => n.props.children), ["clip 01 square", "clip 02 square"]);
  const count = h.render().find(n => n.props?.id === ":preview:-filter-help");
  assert.match(count.props.children.join(""), /2 \/ 3 çıktı gösteriliyor/);
  assert.equal(h.render().find(n => n.type === "a").props.href, "download:all.zip");
  assert.equal(JSON.stringify(h.job), before);
});

test("filter changes close playback and returning to all does not reopen it", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  const previous = h.videos()[0];
  h.filter().props.onChange({ target: { value: "9:16" } });
  assert.equal(h.videos().length, 0);
  previous.props.onError();
  h.filter().props.onChange({ target: { value: "all" } });
  assert.equal(h.videos().length, 0);
  assert.equal(h.buttons().length, 2);
});

test("new jobs, archives and removed formats fall back to all results", () => {
  const h = harness();
  h.filter().props.onChange({ target: { value: "1:1" } });
  h.setJob({ ...h.job, id: "job-b" });
  assert.equal(h.filter().props.value, "all");
  h.filter().props.onChange({ target: { value: "1:1" } });
  h.setJob({ ...h.job, result: { ...h.job.result, archive: "next.zip" } });
  assert.equal(h.filter().props.value, "all");
  h.filter().props.onChange({ target: { value: "1:1" } });
  h.setJob({ ...h.job, result: { ...h.job.result, outputs: [h.job.result.outputs[1]] } });
  assert.equal(h.filter(), undefined);
  assert.equal(h.buttons().length, 1);
});

test("single-format and empty results need no selector and retain their archive", () => {
  const h = harness();
  for (const outputs of [[h.job.result.outputs[0]], []]) {
    h.setJob({ ...h.job, result: { ...h.job.result, outputs } });
    assert.equal(h.filter(), undefined);
    assert.equal(h.buttons().length, outputs.length);
    assert.equal(h.render().find(n => n.type === "a").props.href, "download:all.zip");
  }
});

test("unsupported filter values are ignored and freshness warnings remain visible", () => {
  const h = harness(); h.buttons()[0].props.onClick();
  h.filter().props.onChange({ target: { value: "21:9" } });
  assert.equal(h.filter().props.value, "all");
  assert.equal(h.videos().length, 1);
  h.setFreshness("stale");
  h.filter().props.onChange({ target: { value: "1:1" } });
  assert.ok(h.render().some(n => typeof n.props?.children === "string" && n.props.children.includes("son hazırlanan dosyalardan farklı")));
  assert.equal(h.buttons().length, 1);
});

test("filtered ZIP link targets only the selected format and leaves the full archive intact", () => {
  const h = harness();
  h.setJob({ ...h.job, result: { ...h.job.result,
    format_archives: { "1:1": "square.zip", "9:16": "portrait.zip" } } });
  const before = JSON.stringify(h.job);
  assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 5);
  for (const [format, url] of [["1:1", "square.zip"], ["9:16", "portrait.zip"]]) {
    h.filter().props.onChange({ target: { value: format } });
    const links = h.render().filter(n => n.type === "a" && n.props.download);
    assert.equal(links.length, 4);
    assert.equal(links[0].props.href, "download:all.zip");
    assert.equal(links[1].props.href, `download:${url}`);
    assert.ok(links[1].props.children.includes(format));
  }
  h.filter().props.onChange({ target: { value: "all" } });
  assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 5);
  assert.equal(JSON.stringify(h.job), before);
});

test("legacy or partially indexed archives never offer a misleading format download", () => {
  const h = harness();
  for (const format_archives of [undefined, {}, { "9:16": "portrait.zip" }]) {
    h.setJob({ ...h.job, result: { ...h.job.result, format_archives } });
    h.filter().props.onChange({ target: { value: "1:1" } });
    assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 3);
    assert.ok(h.render().some(n => Array.isArray(n.props?.children)
      && n.props.children.join("").includes("ayrı 1:1 ZIP arşivi bulunmuyor")));
    assert.equal(h.render().find(n => n.type === "a").props.href, "download:all.zip");
  }
});

test("filtered archive download keeps stale and unknown-result warnings", () => {
  const h = harness();
  h.setJob({ ...h.job, result: { ...h.job.result, format_archives: { "1:1": "square.zip" } } });
  h.filter().props.onChange({ target: { value: "1:1" } });
  for (const freshness of ["stale", "unknown"]) {
    h.setFreshness(freshness);
    assert.ok(h.render().some(n => n.type === "a" && n.props.href === "download:square.zip"));
    const message = freshness === "stale" ? "son hazırlanan dosyalardan farklı" : "güncellik bilgisi olmadan";
    assert.ok(h.render().some(n => typeof n.props?.children === "string" && n.props.children.includes(message)));
  }
});

test("clip grouping uses explicit metadata, preserving order without mutating results", () => {
  const job = groupedJob(); const before = JSON.stringify(job);
  const groups = grouping.groupPublishedClips(job.result);
  assert.deepEqual([...groups].map(g => g.clip_index), [1, 2]);
  assert.equal(groups[0].outputs.length, 2);
  assert.equal(groups[1].archive, "clip-2.zip");
  assert.equal(JSON.stringify(job), before);
  assert.equal(grouping.groupPublishedClips({ ...job.result, clip_archives: undefined }), null);
});

test("incomplete, ambiguous or invalid grouping metadata falls back to the flat list", () => {
  const mutate = [
    r => { r.clip_archives = []; },
    r => { r.clip_archives.push({ ...r.clip_archives[0] }); },
    r => { r.clip_archives[0].start = -1; },
    r => { r.clip_archives[0].end = r.clip_archives[0].start; },
    r => { r.clip_archives[0].archive = ""; },
    r => { r.clip_archives[0].clip_index = 1.5; },
    r => { delete r.outputs[0].clip_index; },
    r => { r.outputs[0].clip_index = 99; },
    r => { r.outputs = r.outputs.filter(o => o.clip_index !== 2); },
    r => { r.outputs.push({ ...r.outputs[0] }); },
  ];
  for (const change of mutate) {
    const result = groupedJob().result; change(result);
    assert.equal(grouping.groupPublishedClips(result), null);
  }
});

test("grouped results show one format card per clip and all-format clip ZIPs", () => {
  const h = harness(); h.setJob(groupedJob());
  assert.equal(h.render().filter(n => n.type === "h5").length, 2);
  assert.deepEqual(h.render().filter(n => n.type === "strong").map(n => n.props.children), ["clip 1 9:16", "clip 2 9:16"]);
  assert.ok(h.render().some(n => n.type === "a" && n.props.href === "download:clip-1.zip"));
  assert.ok(h.render().some(n => n.type === "a" && n.props.href === "download:clip-2.zip"));
  const count = h.render().find(n => n.props?.id === ":preview:-filter-help");
  assert.match(count.props.children.join(""), /4 \/ 4 çıktı filtreyle eşleşiyor/);
  assert.equal(h.videos().length, 0);
  for (const b of h.formats()) assert.ok(h.render().some(n => n.props?.id === b.props["aria-controls"]));
});

test("clip format switching is independent, stops playback and ignores late errors", () => {
  const h = harness(); h.setJob(groupedJob());
  h.buttons()[0].props.onClick(); const oldVideo = h.videos()[0];
  h.formats().find(b => b.props["aria-label"] === "Klip 1 9:16 formatını göster").props.onClick();
  assert.equal(h.videos().length, 1);
  h.formats().find(b => b.props["aria-label"] === "Klip 1 1:1 formatını göster").props.onClick();
  oldVideo.props.onError();
  assert.equal(h.videos().length, 0);
  assert.deepEqual(h.render().filter(n => n.type === "strong").map(n => n.props.children), ["clip 1 1:1", "clip 2 9:16"]);
  assert.equal(h.formats().filter(b => b.props["aria-pressed"]).length, 2);
  h.buttons()[0].props.onClick();
  assert.equal(h.videos()[0].props.src, "media:clip-1-1:1.mp4");
});

test("global filters narrow clip cards but never change the all-format clip archive", () => {
  const h = harness(); h.setJob(groupedJob());
  h.formats().find(b => b.props["aria-label"] === "Klip 1 1:1 formatını göster").props.onClick();
  h.filter().props.onChange({ target: { value: "1:1" } });
  assert.deepEqual(h.render().filter(n => n.type === "strong").map(n => n.props.children), ["clip 1 1:1", "clip 2 1:1"]);
  assert.equal(h.formats().length, 0);
  assert.ok(h.render().some(n => n.type === "a" && n.props.href === "download:clip-1.zip"));
  assert.ok(h.render().some(n => n.type === "a" && n.props.href === "download:group-square.zip"));
  h.filter().props.onChange({ target: { value: "all" } });
  assert.deepEqual(h.render().filter(n => n.type === "strong").map(n => n.props.children), ["clip 1 1:1", "clip 2 9:16"]);
});

test("new result identity resets per-clip format choices", () => {
  const h = harness(); h.setJob(groupedJob());
  for (const patch of [{ id: "next-job" }, { result: { ...groupedJob().result, archive: "next-all.zip" } }]) {
    h.formats().find(b => b.props["aria-label"] === "Klip 1 1:1 formatını göster").props.onClick();
    h.setJob({ ...h.job, ...patch });
    assert.equal(h.render().find(n => n.type === "strong").props.children, "clip 1 9:16");
  }
});

test("legacy or incomplete clip metadata keeps flat downloads and freshness warnings", () => {
  const h = harness(); const job = groupedJob(); delete job.result.outputs[0].clip_index;
  h.setJob(job); h.setFreshness("stale");
  assert.equal(h.render().filter(n => n.type === "h5").length, 0);
  assert.equal(h.render().filter(n => n.type === "strong").length, 4);
  assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 9);
  assert.ok(h.render().some(n => typeof n.props?.children === "string" && n.props.children.includes("son hazırlanan dosyalardan farklı")));
});

function editableResult() {
  const result = groupedJob().result;
  result.clip_request = { analysis_id: "current-analysis", render_revision: "revision-a", clips: [
    { id: 22, start: 30, end: 60, cover_at: 0 }, { id: 0, start: 60, end: 90, cover_at: 0 },
  ] };
  return result;
}

test("edit targets use rendered selection order, including candidate zero", () => {
  const targets = grouping.editablePublishedClipIds(editableResult(), "current-analysis", [{ id: 0 }, { id: 22 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), { 1: 22, 2: 0 });
});

test("foreign analyses, missing candidates and legacy results have no edit targets", () => {
  const result = editableResult();
  for (const analysisId of [undefined, "different-analysis"]) {
    assert.deepEqual(Object.keys(grouping.editablePublishedClipIds(result, analysisId, [{ id: 22 }, { id: 0 }])), []);
  }
  assert.deepEqual(Object.keys(grouping.editablePublishedClipIds(result, "current-analysis", [{ id: 22 }])), []);
  delete result.clip_request;
  assert.deepEqual(Object.keys(grouping.editablePublishedClipIds(result, "current-analysis", [{ id: 22 }, { id: 0 }])), []);
});

test("inconsistent snapshots cannot navigate to the wrong clip", () => {
  for (const change of [
    r => { r.clip_request.clips[0].start = 31; },
    r => { r.clip_request.clips[0].end = 61; },
    r => { r.clip_request.clips[1].id = 22; },
    r => { r.clip_request.clips[0].id = -1; },
    r => { r.clip_request.clips.pop(); },
    r => { delete r.clip_archives; },
  ]) {
    const result = editableResult(); change(result);
    assert.deepEqual(Object.keys(grouping.editablePublishedClipIds(result, "current-analysis", [{ id: 22 }, { id: 0 }])), []);
  }
});

test("edit target lookup never resets current trims or mutates input data", () => {
  const result = editableResult();
  const candidates = [{ id: 22, start: 29, end: 60 }, { id: 0, start: 59, end: 90 }];
  const before = JSON.stringify({ result, candidates });
  assert.equal(grouping.editablePublishedClipIds(result, "current-analysis", candidates)[1], 22);
  assert.equal(JSON.stringify({ result, candidates }), before);
});

test("edit action closes playback and invokes only the matching clip callback", () => {
  const h = harness(); h.setJob(groupedJob());
  const called = []; h.setClipEditors({ 1: () => called.push(22), 2: () => called.push(0) });
  const before = JSON.stringify(h.job);
  h.buttons()[0].props.onClick();
  const edits = h.render().filter(n => n.type === "button" && n.props.children === "Klibi düzenle");
  assert.equal(edits.length, 2);
  edits[0].props.onClick();
  assert.deepEqual(called, [22]);
  assert.equal(h.videos().length, 0);
  assert.equal(JSON.stringify(h.job), before);
});

test("edit controls appear only when an explicit clip editor is available", () => {
  const h = harness(); h.setJob(groupedJob());
  const edits = () => h.render().filter(n => n.type === "button" && n.props.children === "Klibi düzenle");
  assert.equal(edits().length, 0);
  h.setClipEditors({ 2: () => {} });
  assert.equal(edits().length, 1);
  assert.equal(edits()[0].props["aria-label"], "Klip 2 düzenleme alanına git");
  h.setClipEditors({});
  assert.equal(edits().length, 0);
});

const restoreCandidates = () => [{ id: 22, start: 29, end: 60 }, { id: 0, start: 60, end: 90 }];
const restores = (result = editableResult(), candidates = restoreCandidates(), duration = 90,
  revision = "revision-a", analysis = "current-analysis") =>
  grouping.publishedClipRangeRestores(result, analysis, candidates, duration, revision);

test("rendered timing restore targets contain only changed clips and do not mutate inputs", () => {
  const result = editableResult(); const candidates = restoreCandidates();
  const before = JSON.stringify({ result, candidates });
  const targets = restores(result, candidates);
  assert.deepEqual(Object.keys(targets), ["1"]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets[1])), {
    id: 22, current: { start: 29, end: 60 }, rendered: { start: 30, end: 60 },
  });
  assert.equal(JSON.stringify({ result, candidates }), before);
});

test("restore requires the same analysis and a known matching project revision", () => {
  for (const revision of [undefined, "", "revision-b"]) {
    assert.deepEqual(Object.keys(grouping.publishedClipRangeRestores(editableResult(), "current-analysis", restoreCandidates(), 90, revision)), []);
  }
  assert.deepEqual(Object.keys(restores(editableResult(), restoreCandidates(), 90, "revision-a", "other-analysis")), []);
  const result = editableResult(); delete result.clip_request.render_revision;
  assert.deepEqual(Object.keys(restores(result)), []);
});

test("out-of-source and non-30-to-60-second rendered timing cannot be restored", () => {
  for (const range of [{ start: 10, end: 20 }, { start: -1, end: 30 }, { start: 0, end: 70 }, { start: 80, end: 110 }]) {
    const result = editableResult();
    Object.assign(result.clip_archives[0], range);
    Object.assign(result.clip_request.clips[0], range);
    assert.deepEqual(Object.keys(restores(result)), []);
  }
  assert.deepEqual(Object.keys(restores(editableResult(), restoreCandidates(), 89)), []);
});

test("an unfinished target can be repaired but another invalid range must not be overwritten", () => {
  const candidates = restoreCandidates(); candidates[0].start = NaN;
  assert.equal(restores(editableResult(), candidates)[1].rendered.start, 30);
  const changed = restoreCandidates(); changed[1].end = 50;
  const targets = restores(editableResult(), changed);
  assert.equal(targets[1], undefined);
  assert.equal(targets[2].id, 0);
  const unchanged = [{ id: 22, start: 30, end: 60 }, { id: 0, start: 60, end: 90 }];
  assert.deepEqual(Object.keys(restores(editableResult(), unchanged)), []);
});

test("applying restored timing is one undoable range step and leaves other settings alone", () => {
  const target = restores()[1];
  const draft = { selected: [0, 22], covers: { 22: 30.5, 0: 0 }, options: { quality: "fast" } };
  const settings = JSON.stringify(draft);
  let state = history.clipRangeHistoryReducer(history.emptyClipRangeHistory, {
    type: "reset", context: "current", ranges: { 22: { start: 29, end: 60 }, 0: { start: 60, end: 90 } },
  });
  state = history.clipRangeHistoryReducer(state, { type: "commit", context: "current", duration: 90, ranges: current => current });
  state = history.clipRangeHistoryReducer(state, { type: "commit", context: "current", duration: 90,
    ranges: current => ({ ...current, [target.id]: { ...target.rendered } }) });
  assert.equal(state.past.length, 1);
  assert.equal(state.present[22].start, 30);
  assert.equal(state.present[0].start, 60);
  assert.equal(JSON.stringify(draft), settings);
  state = history.clipRangeHistoryReducer(state, { type: "undo", context: "current" });
  assert.equal(state.present[22].start, 29);
  assert.equal(state.future.length, 1);
});

test("valid pending edits are committed before restoration so undo can recover them", () => {
  const target = restores()[1];
  let state = history.clipRangeHistoryReducer(history.emptyClipRangeHistory, {
    type: "reset", context: "current", ranges: { 22: { start: 30, end: 60 }, 0: { start: 60, end: 90 } },
  });
  state = history.clipRangeHistoryReducer(state, { type: "preview", context: "current", duration: 90,
    ranges: current => ({ ...current, 22: { start: 29, end: 60 } }) });
  state = history.clipRangeHistoryReducer(state, { type: "commit", context: "current", duration: 90, ranges: current => current });
  state = history.clipRangeHistoryReducer(state, { type: "commit", context: "current", duration: 90,
    ranges: current => ({ ...current, [target.id]: { ...target.rendered } }) });
  assert.equal(state.past.length, 2);
  assert.equal(state.present[22].start, 30);
  state = history.clipRangeHistoryReducer(state, { type: "undo", context: "current" });
  assert.equal(state.present[22].start, 29);
  state = history.clipRangeHistoryReducer(state, { type: "redo", context: "current" });
  assert.equal(state.present[22].start, 30);
});

test("restoration explains exact timing, closes playback and invokes only its callback", () => {
  const h = harness(); h.setJob(groupedJob());
  const before = JSON.stringify(h.job); let calls = 0;
  h.setClipRangeRestorers({ 1: { current: { start: 29, end: 60 }, restore: () => { calls++; } } });
  h.buttons()[0].props.onClick();
  const text = h.render().filter(n => n.type === "p").map(n => [n.props.children].flat(Infinity).join("")).join(" ");
  assert.match(text, /Son render aralığı: 30\.000 – 60\.000 sn/);
  assert.match(text, /Taslak aralığı: 29\.000 – 60\.000 sn/);
  const actions = h.render().filter(n => n.type === "button" && n.props.children === "Son render aralığına dön");
  assert.equal(actions.length, 1);
  actions[0].props.onClick();
  assert.equal(calls, 1);
  assert.equal(h.videos().length, 0);
  assert.equal(JSON.stringify(h.job), before);
  h.setClipRangeRestorers({});
  assert.equal(h.render().filter(n => n.type === "button" && n.props.children === "Son render aralığına dön").length, 0);
});

test("unfinished input is described without showing NaN timing", () => {
  const h = harness(); h.setJob(groupedJob());
  h.setClipRangeRestorers({ 1: { current: { start: NaN, end: 60 }, restore: () => {} } });
  const text = h.render().filter(n => n.type === "p").map(n => [n.props.children].flat(Infinity).join("")).join(" ");
  assert.match(text, /geçersiz veya tamamlanmamış giriş/);
  assert.equal(text.includes("NaN"), false);
});

test("incremental counts, per-clip freshness and reused-output labels are explicit", () => {
  const h = harness(); const job = groupedJob();
  job.result.reused_outputs = 2; job.result.rendered_outputs = 2;
  job.result.outputs[0].reused = true;
  h.setJob(job); h.setClipFreshness({ 1: "fresh", 2: "stale" });
  const text = h.render().map(n => [n.props?.children].flat(Infinity).join("")).join(" ");
  assert.match(text, /2 çıktı korundu · 2 çıktı yeniden hazırlandı/);
  assert.match(text, /Girdiler aynı/);
  assert.match(text, /Yeniden hazırlanmalı/);
  assert.match(text, /Önceki sonuçtan doğrulanarak korundu/);
  assert.equal(h.videos().length, 0);
});

test("legacy results without incremental metadata do not claim reused files", () => {
  const h = harness(); h.setJob(groupedJob());
  const text = h.render().map(n => [n.props?.children].flat(Infinity).join("")).join(" ");
  assert.equal(text.includes("çıktı korundu"), false);
  assert.equal(text.includes("Önceki sonuçtan doğrulanarak korundu"), false);
  assert.equal(h.render().filter(n => n.type === "a" && n.props.download).length, 7);
});
