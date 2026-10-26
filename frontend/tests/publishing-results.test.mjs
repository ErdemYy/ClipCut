import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(fs.readFileSync(new URL("../components/editor/PublishingControls.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

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
    if (name === "@/lib/api") return { mediaUrl: (s) => `media:${s}`, downloadUrl: (s) => `download:${s}`, formatTime: String };
    if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) };
    throw new Error(`Unexpected import ${name}`);
  } });
  const output = (name) => ({ label: `clip_01_${name}`, aspect_ratio: name === "square" ? "1:1" : "9:16", width: 720, height: 720,
    duration: 30, output: `${name}.mp4`, thumbnail: `${name}.jpg`, thumbnail_fallback: false });
  let job = { id: "job-a", status: "done", result: { archive: "all.zip", outputs: [output("square"), output("portrait")] } };
  let freshness;
  const nodes = (n) => !n || typeof n !== "object" ? []
    : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)];
  const render = () => { cursor = 0; return nodes(exports.PublishingResults({ job, freshness })); };
  const buttons = () => render().filter(n => n.type === "button" && n.props["aria-controls"]);
  return { render, buttons, videos: () => render().filter(n => n.type === "video"),
    filter: () => render().find(n => n.type === "select"),
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
