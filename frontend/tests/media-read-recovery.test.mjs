import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const revision = "a".repeat(64), nextRevision = "b".repeat(64);
const project = () => ({ id: "p", status: "ready", source_url: "/source.mp4", duration: 5, has_audio: true,
  plan: { operations: [{ type: "text", text: "Caption", start: 1, duration: 2 }] }, timeline_revision: revision, render_revision: revision, can_undo: true });
const timeline = (rev = revision) => ({ source_duration: 5, output_duration: 5, exact_output_duration: 5, speed: 1, crossfade: 0, segments: [[0, 5]], revision: rev });
const waveform = (has_audio = true) => ({ duration: 5, has_audio, peaks: has_audio ? [0, 0.2, 0.5] : [], sample_rate: 8000, revision });

function harness(component, api = {}, extra = {}) {
  const hooks = [], effects = [], modules = new Map(), timers = new Map(), calls = [], saved = [], notices = [], published = [];
  let cursor = 0, clock = 0, disposed = false, lateWrites = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++; hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next) => { if (disposed) lateWrites++; hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; }];
    },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, value: fn }; return hooks[index].value; },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) { hooks[index]?.cleanup?.(); hooks[index] = { deps }; effects.push(() => { hooks[index].cleanup = fn(); }); }
    },
  };
  const defaults = { timeline: async () => timeline(), waveform: async () => waveform(), project: async () => project() };
  const methods = new Proxy({}, { get(_target, name) { return (...args) => {
    calls.push({ name, args }); const fn = api[name] ?? defaults[name];
    if (!fn) throw new Error(`Unexpected mutation ${String(name)}`);
    return fn(...args);
  }; } });
  const jsx = (type, props, key) => typeof type === "function" ? type({ ...props, __key: key }) : ({ type, props, key });
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, AbortController, AbortSignal, setTimeout(fn) { const id = ++clock; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, ...extra,
      require(name) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "@/lib/api") return { api: methods, formatTime: (n) => `0:${n}`, mediaUrl: (v) => v, downloadUrl: (v) => v };
        if (name === "@/lib/use-read-resource") return load("../lib/use-read-resource.ts");
        if (name === "@/lib/media-reads") return load("../lib/media-reads.ts");
        if (name === "@/lib/layer-timeline") return load("../lib/layer-timeline.ts");
        if (name === "@/lib/render-preview") return load("../lib/render-preview.ts");
        if (name === "./ReadResourceStatus") return load("../components/editor/ReadResourceStatus.tsx");
        if (name === "./SourceWaveform") return load("../components/editor/SourceWaveform.tsx");
        if (name === "./Timeline") return { default: (props) => ({ type: "timeline-view", props }) };
        if (name === "./SubtitlePanel") return { JobProgress: () => null };
        if (name.endsWith(".css")) return { default: {} };
        throw new Error(`Unexpected import ${name}`);
      },
    });
    modules.set(file, exports); return exports;
  }
  const root = load(`../components/editor/${component}.tsx`).default;
  const props = { project: project(), time: 0, timeline: timeline(), onSeek() {}, readOnly: false, jobs: {},
    options: { resolution: "720p", quality: "fast" }, track: async () => {},
    setProject: (p) => saved.push(p), onTimeline: (v) => { published.push(v); return true; }, notify: (...args) => notices.push(args) };
  return { props, calls, saved, notices, published, load,
    render() { cursor = 0; const result = root(props); effects.splice(0).forEach((fn) => fn()); return result; },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
    unmount() { disposed = true; hooks.forEach((hook) => hook?.cleanup?.()); },
    get lateWrites() { return lateWrites; },
  };
}
function find(node, id) {
  if (!node || typeof node !== "object") return;
  if (typeof id === "function" ? id(node) : node.props?.id === id) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, id)).find(Boolean);
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(text).join(" ");
}
const view = (tree) => find(tree, (node) => node.type === "timeline-view");

test("timeline failure remains recoverable while waveform loads independently; retries are single-flight GETs", async () => {
  let reads = 0; const recovery = deferred();
  const h = harness("TimelineWorkspace", { timeline: async () => { if (++reads === 1) throw new Error("timeline offline"); return recovery.promise; } });
  h.render(); h.flushTimers(); await settle(); let tree = h.render();
  assert.equal(find(tree, "timeline-read-error").props.role, "alert");
  assert.ok(find(tree, (node) => node.props?.role === "img"));
  assert.equal(view(tree), undefined);
  const retry = find(tree, "timeline-read-retry"); retry.props.onClick(); retry.props.onClick();
  await settle(); assert.equal(reads, 2);
  assert.equal(find(h.render(), "timeline-read-retry").props.disabled, true);
  recovery.resolve(timeline()); await settle(); tree = h.render();
  assert.equal(find(tree, "timeline-read-error"), undefined);
  assert.equal(view(tree).props.readOnly, false);
  assert.equal(h.calls.filter((call) => call.name === "waveform").length, 1);
  assert.ok(h.calls.every((call) => ["timeline", "waveform"].includes(call.name)));
  h.unmount();
});

test("failed timeline refresh preserves a same-source instance read-only and recovery unlocks it", async () => {
  let reads = 0;
  const h = harness("TimelineWorkspace", { timeline: async () => { if (++reads === 2) throw new Error("refresh failed"); return timeline(); } });
  h.render(); h.flushTimers(); await settle(); let tree = h.render(); const key = view(tree).props.__key;
  find(tree, "timeline-read-retry").props.onClick(); await settle(); tree = h.render();
  assert.equal(view(tree).props.__key, key);
  assert.equal(view(tree).props.readOnly, true);
  assert.match(text(tree), /Son yüklenen veri korunuyor/);
  find(tree, "timeline-read-retry").props.onClick(); await settle(); tree = h.render();
  assert.equal(view(tree).props.readOnly, false); assert.equal(view(tree).props.__key, key);
  h.unmount();
});

test("an explicitly validated timeline publication cancels an older in-flight refresh", async () => {
  const stale = deferred(); let reads = 0;
  const h = harness("TimelineWorkspace", { timeline: async () => ++reads === 2 ? stale.promise : timeline() });
  h.render(); h.flushTimers(); await settle(); let tree = h.render();
  find(tree, "timeline-read-retry").props.onClick(); await settle();
  const signal = h.calls.filter((call) => call.name === "timeline").at(-1).args[1];
  assert.equal(view(tree).props.onTimeline({ ...timeline(), output_duration: 4, exact_output_duration: 4 }), true);
  assert.equal(signal.aborted, true);
  stale.resolve({ ...timeline(), output_duration: 1 }); await settle(); tree = h.render();
  assert.equal(view(tree).props.timeline.output_duration, 4);
  h.unmount();
});

test("plan changes ignore late old reads, reject a server revision mismatch and do not re-extract source waveform", async () => {
  const old = deferred(); let reads = 0;
  const h = harness("TimelineWorkspace", { timeline: async () => { reads++; if (reads === 2) return old.promise; return timeline(reads >= 4 ? nextRevision : revision); } });
  h.render(); h.flushTimers(); await settle(); let tree = h.render();
  find(tree, "timeline-read-retry").props.onClick(); await settle();
  const oldSignal = h.calls.filter((call) => call.name === "timeline").at(-1).args[1];
  h.props.project = { ...project(), timeline_revision: nextRevision, plan: { operations: [] } };
  tree = h.render(); assert.equal(view(tree).props.readOnly, true);
  h.flushTimers(); old.resolve(timeline()); await settle(); tree = h.render();
  assert.equal(oldSignal.aborted, true);
  assert.match(text(tree), /proje sürümüyle eşleşmiyor/);
  assert.equal(view(tree).props.timeline.revision, revision);
  assert.equal(view(tree).props.readOnly, true);
  find(tree, "timeline-read-retry").props.onClick(); await settle(); tree = h.render();
  assert.equal(view(tree).props.timeline.revision, nextRevision);
  assert.equal(view(tree).props.readOnly, false);
  assert.equal(h.calls.filter((call) => call.name === "waveform").length, 1);
  h.unmount();
});

test("source/project changes hide old waveform and timeline immediately and abort old reads", async () => {
  const oldWave = deferred(), oldTimeline = deferred(); let waves = 0, timelines = 0;
  const h = harness("TimelineWorkspace", {
    waveform: async () => ++waves === 2 ? oldWave.promise : waveform(),
    timeline: async () => ++timelines === 2 ? oldTimeline.promise : timeline(),
  });
  h.render(); h.flushTimers(); await settle(); let tree = h.render();
  find(tree, "timeline-read-retry").props.onClick(); find(tree, "waveform-read-retry").props.onClick(); await settle();
  const oldSignals = h.calls.slice(-2).map((call) => call.args[1]);
  h.props.project = { ...project(), id: "next", source_url: "/different.mp4" };
  tree = h.render();
  assert.equal(view(tree), undefined); assert.equal(find(tree, (node) => node.props?.role === "img"), undefined);
  assert.ok(oldSignals.every((signal) => signal.aborted));
  h.flushTimers(); await settle();
  oldWave.resolve({ ...waveform(), peaks: [1] }); oldTimeline.resolve({ ...timeline(), output_duration: 1 });
  await settle(); tree = h.render();
  assert.equal(view(tree).props.timeline.output_duration, 5);
  h.unmount();
});

test("waveform failure is not 'no audio'; explicit no-channel and silent-channel results remain distinct", async () => {
  let reads = 0;
  const h = harness("SourceWaveform", { waveform: async () => { if (++reads === 1) throw new Error("analysis failed"); return waveform(false); } });
  h.props.project = { ...project(), has_audio: false };
  h.render(); await settle(); let tree = h.render();
  assert.match(text(tree), /analysis failed/); assert.doesNotMatch(text(tree), /ses kanalı yok/);
  find(tree, "waveform-read-retry").props.onClick(); await settle(); tree = h.render();
  assert.match(text(tree), /ses kanalı yok/); assert.equal(find(tree, (node) => node.props?.role === "img"), undefined);
  h.unmount();
  const silent = harness("SourceWaveform", { waveform: async () => ({ ...waveform(), peaks: [0, 0, 0] }) });
  silent.render(); await settle(); tree = silent.render();
  assert.ok(find(tree, (node) => node.props?.role === "img")); assert.doesNotMatch(text(tree), /ses kanalı yok/);
  silent.unmount();
});

test("waveform refresh keeps compatible peaks on failure, without relaunching timeline or production", async () => {
  let reads = 0;
  const h = harness("SourceWaveform", { waveform: async () => { if (++reads === 2) throw new Error("retry later"); return waveform(); } });
  h.render(); await settle(); let tree = h.render();
  const retry = find(tree, "waveform-read-retry"); retry.props.onClick(); retry.props.onClick();
  await settle(); tree = h.render();
  assert.ok(find(tree, (node) => node.props?.role === "img"));
  assert.match(text(tree), /Son yüklenen veri korunuyor/);
  assert.equal(reads, 2); assert.ok(h.calls.every((call) => call.name === "waveform"));
  h.unmount();
});

test("media reads have bounded timeline/analysis timeouts and cleanup never publishes late data/errors", async () => {
  const timeouts = [], signals = [];
  const fake = { timeout(ms) { const controller = new AbortController(); timeouts.push({ ms, controller }); return controller.signal; }, any: AbortSignal.any.bind(AbortSignal) };
  const wait = (_id, signal) => { signals.push(signal); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); };
  const h = harness("TimelineWorkspace", { timeline: wait, waveform: wait }, { AbortSignal: fake });
  h.render(); h.flushTimers(); await settle();
  assert.deepEqual(timeouts.map((item) => item.ms).sort((a, b) => a - b), [15000, 130000]);
  timeouts.forEach(({ controller }) => controller.abort(new DOMException("timeout", "TimeoutError")));
  await settle(); const tree = h.render();
  assert.match(text(find(tree, "timeline-read-error")), /zaman aşımına/);
  assert.match(text(find(tree, "waveform-read-error")), /zaman aşımına/);
  assert.equal(find(tree, "timeline-read-retry").props.disabled, false);
  h.unmount();
  const late = deferred();
  const unmounted = harness("SourceWaveform", { waveform: (_id, signal) => { signals.push(signal); return late.promise; } });
  unmounted.render(); await settle(); unmounted.unmount();
  assert.equal(signals.at(-1).aborted, true); late.reject(new Error("late")); await settle();
  assert.equal(unmounted.lateWrites, 0);
});

test("preview timeline retry preserves selection/downloads and never starts a preview render", async () => {
  let reads = 0;
  const h = harness("PreviewPanel", { timeline: async () => { reads++; if (reads === 1 || reads === 3) throw new Error("preview read offline"); return timeline(); } });
  h.props.jobs = { preview: { id: "done", status: "done", result: { output: "/old.mp4", start: 0, end: 5, duration: 5,
    width: 160, height: 90, resolution: "720p", quality: "fast", render_revision: revision } } };
  h.render(); await settle(); let tree = h.render();
  assert.ok(find(tree, "preview-timeline-read-error"));
  assert.equal(find(tree, "render-preview-generate").props.disabled, true);
  assert.ok(find(tree, (node) => node.type === "a" && node.props.href === "/old.mp4"));
  find(tree, "preview-timeline-read-retry").props.onClick(); await settle(); tree = h.render();
  find(tree, "render-preview-start").props.onChange({ target: { value: "1.25" } });
  find(tree, "render-preview-duration").props.onChange({ target: { value: "10" } });
  tree = h.render(); find(tree, "preview-timeline-read-retry").props.onClick(); await settle(); tree = h.render();
  assert.equal(find(tree, "render-preview-start").props.value, 1.25);
  assert.equal(find(tree, "render-preview-duration").props.value, 10);
  assert.equal(find(tree, "render-preview-generate").props.disabled, true);
  assert.ok(find(tree, (node) => node.type === "a" && node.props.href === "/old.mp4"));
  assert.ok(h.calls.every((call) => call.name === "timeline"));
  h.unmount();
});

test("timeline draft survives read-only refresh failures; explicit successful discard alone clears it", async () => {
  let reads = 0;
  const h = harness("Timeline", { project: async () => { if (++reads === 1) throw new Error("project offline"); return project(); } });
  let tree = h.render(); find(tree, "timeline-layer-select").props.onChange({ target: { value: "0" } });
  tree = h.render(); find(tree, "layer-start").props.onChange({ target: { value: "1.5" } }); tree = h.render();
  assert.equal(find(tree, "timeline-save").props.disabled, false);
  h.props.readOnly = true; tree = h.render(); assert.equal(find(tree, "timeline-save").props.disabled, true);
  const retry = find(tree, "timeline-discard"); const first = retry.props.onClick(); await retry.props.onClick(); await first;
  tree = h.render(); assert.equal(find(tree, "layer-start").props.value, 1.5); assert.equal(reads, 1);
  assert.match(h.notices[0][0], /taslak korunuyor/);
  h.props.readOnly = false; tree = h.render();
  await find(tree, "timeline-discard").props.onClick(); tree = h.render();
  assert.equal(find(tree, "layer-start"), undefined);
  assert.equal(h.published.length, 1); assert.equal(h.saved.length, 1);
  assert.ok(h.calls.every((call) => ["project", "timeline"].includes(call.name)));
  h.unmount();
});

test("a timeline project-reload response from an obsolete source cannot publish or clear the draft", async () => {
  const late = deferred();
  const h = harness("Timeline", { project: () => late.promise });
  let tree = h.render(); find(tree, "timeline-layer-select").props.onChange({ target: { value: "0" } });
  tree = h.render(); find(tree, "layer-start").props.onChange({ target: { value: "1.5" } });
  tree = h.render(); const loading = find(tree, "timeline-discard").props.onClick();
  const signal = h.calls.at(-1).args[1];
  h.props.project = { ...project(), source_url: "/replacement.mp4", timeline_revision: nextRevision };
  h.render(); assert.equal(signal.aborted, true);
  late.resolve(project()); await loading;
  assert.equal(h.saved.length, 0); assert.equal(h.published.length, 0);
  assert.ok(h.calls.every((call) => call.name === "project"));
  h.unmount();
});

test("unready sources and disposed debounce effects start no media requests", async () => {
  const h = harness("SourceWaveform"); h.props.project = { ...project(), status: "generating" };
  let tree = h.render(); await settle();
  assert.equal(find(tree, "waveform-read-retry").props.disabled, true); assert.equal(h.calls.length, 0);
  h.props.project = project(); h.render(); await settle(); assert.equal(h.calls.length, 1); h.unmount();
  const disposed = harness("TimelineWorkspace"); disposed.render(); disposed.unmount(); disposed.flushTimers(); await settle();
  assert.equal(disposed.calls.length, 0);
});

test("scopes and response validation reject malformed/mismatched media without confusing render-only edits", () => {
  const h = harness("SourceWaveform");
  const helpers = h.load("../lib/media-reads.ts");
  assert.equal(helpers.sourceReadKey(project()), helpers.sourceReadKey({ ...project(), name: "Rename", plan: { operations: [] } }));
  assert.notEqual(helpers.timelineReadKey(project()), helpers.timelineReadKey({ ...project(), timeline_revision: nextRevision }));
  assert.throws(() => helpers.checkedTimeline(timeline(nextRevision), 5, revision), /eşleşmiyor/);
  assert.throws(() => helpers.checkedTimeline({ ...timeline(), segments: [[0, 8]] }, 5), /geçersiz/);
  assert.throws(() => helpers.checkedWaveform({ ...waveform(), peaks: [NaN] }, 5, true), /geçersiz/);
  assert.throws(() => helpers.checkedWaveform(waveform(false), 5, true), /geçersiz/);
});
