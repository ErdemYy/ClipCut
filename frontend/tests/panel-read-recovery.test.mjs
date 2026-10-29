import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const project = (id = "p") => ({ id, plan: { operations: [] }, render_revision: "rev", edit_revision: "edit", duration: 5 });

// Run actual panels, the shared hook and status component with deterministic React hooks.
function harness(panel, api, extra = {}) {
  const hooks = [], effects = [], modules = new Map(), calls = [], saved = [], messages = [];
  let cursor = 0, unmounted = false, lateWrites = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (value) => {
        if (unmounted) lateWrites++;
        hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value;
      }];
    },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index]; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, value: fn };
      return hooks[index].value;
    },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, value: fn() };
      return hooks[index].value;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) {
        hooks[index]?.cleanup?.(); hooks[index] = { deps };
        effects.push(() => { hooks[index].cleanup = fn(); });
      }
    },
  };
  const defaults = { templates: async () => [], voices: async () => [], brollLibrary: async () => [], projectAudio: async () => [] };
  const methods = new Proxy({}, { get(_target, name) {
    return (...args) => {
      calls.push({ name, args });
      const fn = api[name] ?? defaults[name];
      if (!fn) throw new Error(`Unexpected mutation/API ${String(name)}`);
      return fn(...args);
    };
  } });
  const jsx = (type, props) => typeof type === "function" ? type(props) : ({ type, props });
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, AbortController, AbortSignal, ...extra, require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@/lib/api") return { api: methods, API_URL: "", mediaUrl: (value) => value, describeOp: () => "", OP_LABELS: {} };
      if (name === "@/lib/use-read-list") return load("../lib/use-read-list.ts");
      if (name === "./ReadListStatus") return load("../components/editor/ReadListStatus.tsx");
      if (name.endsWith(".css")) return { default: {} };
      throw new Error(`Unexpected import ${name}`);
    } });
    modules.set(file, exports);
    return exports;
  }
  const component = load(`../components/editor/${panel}.tsx`).default;
  const props = { project: project(), library: null, disabled: false, setProject: (value) => saved.push(value),
    notify: (...args) => messages.push(args) };
  return {
    props, calls, saved, messages,
    render() { cursor = 0; const tree = component(props); effects.splice(0).forEach((fn) => fn()); return tree; },
    unmount() { unmounted = true; hooks.forEach((hook) => hook?.cleanup?.()); },
    get lateWrites() { return lateWrites; },
  };
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (typeof predicate === "string" ? node.props?.id === predicate : predicate(node)) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, predicate)).find(Boolean);
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(text).join(" ");
}
const cases = [
  { panel: "TemplatesPanel", method: "templates", id: "templates-list", item: { id: "kept", name: "Stored item", description: "", tag: "Test", plan: { operations: [] } } },
  { panel: "VoiceoverPanel", method: "voices", id: "voices-list", item: { id: "kept", name: "Stored item", gender: "female", accent: "Test", style: "Test", description: "" } },
  { panel: "BrollPanel", method: "brollLibrary", id: "broll-list", item: { id: "kept", label: "Stored item", icon: "x", category: "Test", url: "/fixture.jpg" } },
  { panel: "AudioPanel", method: "projectAudio", id: "audio-list", item: { id: "kept", label: "Stored item", url: "/fixture.mp3" } },
];

for (const { panel, method, id, item } of cases) {
  test(`${panel}: independent manual retry coalesces and failed refresh retains the last successful list`, async () => {
    const pending = deferred(); let reads = 0;
    const h = harness(panel, { [method]: async () => {
      reads++;
      if (reads === 1 || reads === 3) throw new Error("list offline");
      return pending.promise;
    } });
    let tree = h.render();
    assert.equal(find(tree, `${id}-retry`).props.disabled, true);
    assert.equal(find(tree, `${id}-empty`), undefined);
    await settle(); tree = h.render();
    assert.equal(find(tree, `${id}-error`).props.role, "alert");
    assert.match(text(tree), /list offline/);
    const retry = find(tree, `${id}-retry`);
    retry.props.onClick(); retry.props.onClick();
    assert.equal(reads, 2);
    assert.equal(find(h.render(), `${id}-retry`).props.disabled, true);
    pending.resolve([item]); await settle(); tree = h.render();
    assert.equal(find(tree, `${id}-error`), undefined);
    assert.match(text(tree), /Stored item/);
    find(tree, `${id}-retry`).props.onClick();
    await settle(); tree = h.render();
    assert.match(text(tree), /Son bilinen liste korunuyor/);
    assert.match(text(tree), /Stored item/);
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.every((call) => call.name === method));
    assert.equal(h.saved.length, 0); assert.equal(h.messages.length, 0);
    h.unmount();
  });

  test(`${panel}: a successful empty list is not misrepresented as loading or failure`, async () => {
    const h = harness(panel, { [method]: async () => [] });
    h.render(); await settle(); const tree = h.render();
    assert.equal(find(tree, `${id}-empty`).props.role, "status");
    assert.equal(find(tree, `${id}-error`), undefined);
    assert.equal(find(tree, `${id}-retry`).props.disabled, false);
    assert.equal(h.calls.length, 1);
    h.unmount();
  });
}

test("shared panel-list lifecycle times out at 15s and permits a manual retry without retrying automatically", async () => {
  const timers = [];
  const fakeSignals = { timeout(ms) { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; },
    any: AbortSignal.any.bind(AbortSignal) };
  let reads = 0;
  const h = harness("TemplatesPanel", { templates: async (signal) => {
    reads++;
    if (reads > 1) return [];
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  } }, { AbortSignal: fakeSignals });
  h.render(); await settle();
  assert.equal(timers[0].ms, 15000);
  timers[0].controller.abort(new DOMException("timeout", "TimeoutError"));
  await settle(); let tree = h.render();
  assert.match(text(find(tree, "templates-list-error")), /zaman aşımına/);
  assert.equal(reads, 1);
  find(tree, "templates-list-retry").props.onClick();
  await settle(); tree = h.render();
  assert.equal(find(tree, "templates-list-error"), undefined);
  assert.equal(reads, 2);
  h.unmount();
});

test("project changes and unmount cancel list reads and reject late success/error and old-project items", async () => {
  const old = deferred(), next = deferred(); const signals = [];
  const h = harness("AudioPanel", { projectAudio: async (scope, signal) => {
    signals.push(signal); return scope === "p" ? old.promise : next.promise;
  } });
  h.render(); await settle();
  h.props.project = project("next");
  assert.doesNotMatch(text(h.render()), /Old audio/);
  await settle(); assert.equal(signals[0].aborted, true);
  next.resolve([{ id: "new", label: "New audio", url: "/new.mp3" }]);
  old.resolve([{ id: "old", label: "Old audio", url: "/old.mp3" }]);
  await settle(); let tree = h.render();
  assert.match(text(tree), /New audio/); assert.doesNotMatch(text(tree), /Old audio/);
  const retry = deferred();
  // Separate unmount failure case, where the underlying transport ignores cancellation.
  const disposed = harness("TemplatesPanel", { templates: () => retry.promise });
  disposed.render(); await settle(); disposed.unmount();
  retry.reject(new Error("late transport error")); await settle();
  assert.equal(disposed.lateWrites, 0);
  h.unmount();
  const never = harness("TemplatesPanel", { templates: async () => [] });
  never.render(); never.unmount(); await settle();
  assert.equal(never.calls.length, 0, "a disposed deferred effect must not start a read");
});

test("an audio upload completed during an older GET is retained without duplicate IDs", async () => {
  const list = deferred(), uploaded = { id: "project:new.mp3", label: "Uploaded audio", url: "/new.mp3" };
  const h = harness("AudioPanel", {
    projectAudio: () => list.promise, uploadAudio: async () => uploaded, setPlan: async () => project(),
  });
  let tree = h.render(); await settle();
  const fileInput = find(tree, (node) => node.type === "input" && node.props.type === "file");
  await fileInput.props.onChange({ target: { files: [{}] } });
  list.resolve([{ ...uploaded, label: "Old listing" }]); await settle(); tree = h.render();
  assert.match(text(tree), /Uploaded audio/);
  assert.doesNotMatch(text(tree), /Old listing/);
  assert.equal((text(tree).match(/Uploaded audio/g) ?? []).length, 1);
  assert.equal(find(tree, "audio-list-empty"), undefined);
  assert.equal(h.saved.length, 1);
  assert.equal(h.calls.filter((call) => call.name === "uploadAudio").length, 1);
  h.unmount();
});

test("an upload response after a project change cannot publish a track or plan into the next project", async () => {
  const upload = deferred();
  const h = harness("AudioPanel", { projectAudio: async () => [], uploadAudio: () => upload.promise });
  let tree = h.render(); await settle();
  const uploading = find(tree, (node) => node.type === "input" && node.props.type === "file").props.onChange({ target: { files: [{}] } });
  h.props.project = project("next"); h.render(); await settle();
  upload.resolve({ id: "old", label: "Old uploaded audio", url: "/old.mp3" });
  await uploading; tree = h.render();
  assert.doesNotMatch(text(tree), /Old uploaded audio/);
  assert.equal(h.saved.length, 0); assert.equal(h.messages.length, 0);
  assert.equal(h.calls.filter((call) => call.name === "setPlan").length, 0);
  h.unmount();
});

test("voice selection never refetches the list; list refresh preserves script/speed/selection without TTS", async () => {
  let reads = 0;
  const voices = ["first", "second"].map((id) => ({ id, name: id, gender: "female", description: "" }));
  const h = harness("VoiceoverPanel", { voices: async () => { reads++; if (reads === 2) throw new Error("refresh offline"); return reads === 3 ? [] : voices; } });
  let tree = h.render();
  find(tree, "voiceover-text-input").props.onChange({ target: { value: "Keep this script" } });
  assert.equal(find(h.render(), "btn-voiceover-preview").props.disabled, true, "no hidden default voice before the list loads");
  await settle(); tree = h.render();
  find(tree, "voice-select-second").props.onClick();
  find(tree, "voiceover-speed-slider").props.onChange({ target: { value: "1.15" } });
  tree = h.render(); await settle();
  assert.equal(reads, 1);
  find(tree, "voices-list-retry").props.onClick();
  await settle(); tree = h.render();
  assert.equal(find(tree, "voiceover-text-input").props.value, "Keep this script");
  assert.equal(find(tree, "voiceover-speed-slider").props.value, 1.15);
  assert.match(text(find(tree, "voice-select-second")), /✓/);
  assert.equal(find(tree, "btn-voiceover-preview").props.disabled, false);
  find(tree, "voices-list-retry").props.onClick();
  await settle(); tree = h.render();
  assert.ok(find(tree, "voices-list-empty"));
  assert.equal(find(tree, "voiceover-text-input").props.value, "Keep this script");
  assert.equal(find(tree, "btn-voiceover-preview").props.disabled, true);
  assert.equal(find(tree, "btn-voiceover-apply").props.disabled, true);
  assert.ok(h.calls.every((call) => call.name === "voices"));
  h.unmount();
});
