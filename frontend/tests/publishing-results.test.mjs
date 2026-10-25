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
  let state = null;
  const ref = { current: 0 };
  const jsx = (type, props, key) => ({ type, props, key });
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) {
    if (name === "react") return {
      useId: () => ":preview:",
      useRef: () => ref,
      useState: () => [state, (next) => { state = typeof next === "function" ? next(state) : next; }],
    };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "next/image") return { default: "img" };
    if (name === "@/lib/api") return { mediaUrl: (s) => `media:${s}`, downloadUrl: (s) => `download:${s}`, formatTime: String };
    if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) };
    throw new Error(`Unexpected import ${name}`);
  } });
  const output = (name) => ({ label: `clip_01_${name}`, aspect_ratio: name, width: 720, height: 720,
    duration: 30, output: `${name}.mp4`, thumbnail: `${name}.jpg`, thumbnail_fallback: false });
  let job = { id: "job-a", status: "done", result: { archive: "all.zip", outputs: [output("square"), output("portrait")] } };
  let freshness;
  const nodes = (n) => !n || typeof n !== "object" ? []
    : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)];
  const render = () => nodes(exports.PublishingResults({ job, freshness }));
  const buttons = () => render().filter(n => n.type === "button" && n.props["aria-controls"]);
  return { render, buttons, videos: () => render().filter(n => n.type === "video"),
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
    assert.ok(h.render().some(n => n.props?.role === "status"));
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
