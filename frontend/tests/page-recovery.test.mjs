import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual pages with a small deterministic hook runtime, not source matches.
function pageHarness(file, api, params = { id: "p" }, extra = {}) {
  const hooks = [], pendingEffects = [], timers = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next) => {
        hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: initial };
      return hooks[index];
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, fn };
      return hooks[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps };
        pendingEffects.push(() => { hooks[index].cleanup = fn(); });
      }
    },
  };
  const defaults = {
    library: async () => ({}), jobs: async () => [], project: async () => project(),
    projects: async () => [project()],
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, AbortSignal, confirm: () => true,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: () => {},
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "next/navigation") return { useParams: () => params };
      if (name === "@/lib/api") return { api: { ...defaults, ...api }, waitForJob: api.waitForJob ?? (() => new Promise(() => {})),
        formatTime: () => "0:06", mediaUrl: (p) => p, downloadUrl: (p) => p };
      if (name === "@/lib/render-preview") return { mainRenderFreshness: () => "missing", mainRenderMessage: () => null };
      if (name === "next/link" || name.startsWith("@/components/")) return { default: () => null };
      if (name.endsWith(".css")) return { default: {} };
      throw new Error(`Unexpected import ${name}`);
    }, ...extra,
  });
  return {
    render() { cursor = 0; const tree = exports.default(); pendingEffects.splice(0).forEach((fn) => fn()); return tree; },
    unmount() { hooks.forEach((hook) => hook?.cleanup?.()); },
    timers,
  };
}

function project() {
  return { id: "p", name: "Saved project", status: "ready", duration: 6,
    source_url: "/media/source.mp4", output_url: null, plan: { operations: [] }, chat: [],
    created_at: "2026-10-28", updated_at: "2026-10-28" };
}

function find(node, id) {
  if (!node || typeof node !== "object") return;
  if (node.props?.id === id) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, id)).find(Boolean);
}

function findProps(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node.props ?? {})) return node.props;
  return [node.props?.children].flat(Infinity).map((child) => findProps(child, predicate)).find(Boolean);
}

function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(text).join(" ");
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("editor initial failure is visible and manual retry recovers without reloading the page", async () => {
  let calls = 0;
  const h = pageHarness("../app/editor/[id]/page.tsx", { project: async () => {
    if (++calls === 1) throw new Error("offline");
    return project();
  } });
  h.render(); await settle();
  let tree = h.render();
  assert.match(text(tree), /Proje yüklenemedi/);
  assert.match(text(tree), /offline/);
  assert.ok(find(tree, "editor-retry"));
  find(tree, "editor-retry").props.onClick();
  tree = h.render();
  assert.match(text(tree), /Proje yükleniyor/);
  assert.equal(find(tree, "editor-retry"), undefined);
  await settle(); tree = h.render();
  assert.match(text(tree), /Saved project/);
  assert.doesNotMatch(text(tree), /Proje yüklenemedi/);
  assert.equal(calls, 2);
  h.unmount();
});

test("editor timeout explains the failure, and a late previous-route response cannot replace the next project", async () => {
  const old = deferred(), params = { id: "old" };
  let oldSignal;
  const h = pageHarness("../app/editor/[id]/page.tsx", { project: async (id, signal) => {
    if (id === "old") { oldSignal = signal; return old.promise; }
    return { ...project(), id: "next", name: "Next project" };
  } }, params);
  h.render(); params.id = "next"; h.render();
  assert.equal(oldSignal.aborted, true);
  await settle(); assert.match(text(h.render()), /Next project/);
  old.resolve({ ...project(), id: "old", name: "Stale project" });
  await settle(); assert.doesNotMatch(text(h.render()), /Stale project/);
  h.unmount();
  const timeout = pageHarness("../app/editor/[id]/page.tsx", { project: async () => {
    throw new DOMException("timeout", "TimeoutError");
  } });
  timeout.render(); await settle();
  assert.match(text(timeout.render()), /zaman aşımına uğradı/);
  timeout.unmount();
});

test("editor ignores stale read and mutation responses, including sub-millisecond and old-route responses", async () => {
  const read = deferred();
  let calls = 0;
  const params = { id: "p" };
  const initial = { ...project(), updated_at: "2026-10-29T10:00:00.123100" };
  const h = pageHarness("../app/editor/[id]/page.tsx", { project: async (id) => {
    if (id !== "p") return { ...initial, id, name: "Next route" };
    if (++calls === 1) return initial;
    return read.promise;
  } }, params);
  h.render(); await settle();
  const props = findProps(h.render(), (props) => typeof props.setProject === "function");
  assert.ok(props);
  // The actual parent callback is shared by every panel.
  props.setProject({ ...initial, name: "Latest edit", updated_at: "2026-10-29T10:00:00.123900+00:00" });
  props.setProject({ ...initial, name: "Old mutation", updated_at: "2026-10-29T10:00:00.123800Z" });
  assert.match(text(h.render()), /Latest edit/);
  assert.doesNotMatch(text(h.render()), /Old mutation/);
  props.setProject({ ...initial, status: "generating", name: "Generating", updated_at: "2026-10-29T10:00:00.123950" });
  h.render();
  h.timers.at(-1)();
  props.setProject({ ...initial, status: "generating", name: "Even newer", updated_at: "2026-10-29T10:00:00.124000" });
  read.resolve({ ...initial, status: "generating", name: "Old refresh" });
  await settle();
  assert.match(text(h.render()), /Even newer/);
  assert.equal(calls, 2);
  params.id = "next"; h.render(); await settle();
  props.setProject({ ...initial, name: "Late old-route mutation", updated_at: "2026-10-30T00:00:00" });
  assert.match(text(h.render()), /Next route/);
  assert.doesNotMatch(text(h.render()), /Late old-route/);
  h.unmount();
});

test("editor auxiliary failures are independent and manual retries only read the failed resource", async () => {
  const reads = { project: 0, library: 0, jobs: 0 };
  const library = deferred(), jobs = deferred();
  const h = pageHarness("../app/editor/[id]/page.tsx", {
    project: async () => { reads.project++; return project(); },
    library: async () => { if (++reads.library === 1) throw new Error("library offline"); return library.promise; },
    jobs: async () => { if (++reads.jobs === 1) throw new Error("jobs offline"); return jobs.promise; },
  });
  h.render(); await settle();
  let tree = h.render();
  assert.match(text(tree), /Saved project/);
  assert.match(text(tree), /Kütüphane\s+yüklenemedi.*library offline/);
  assert.match(text(tree), /İş listesi\s+yüklenemedi.*jobs offline/);
  assert.equal(find(tree, "editor-library-error").props.role, "alert");
  const libraryRetry = find(tree, "editor-library-retry");
  libraryRetry.props.onClick(); libraryRetry.props.onClick();
  tree = h.render();
  assert.equal(find(tree, "editor-library-retry").props.disabled, true);
  assert.deepEqual(reads, { project: 1, library: 2, jobs: 1 });
  library.resolve({ music: [{ id: "local", label: "Recovered music" }] });
  await settle(); tree = h.render();
  assert.equal(find(tree, "editor-library-error"), undefined);
  assert.ok(find(tree, "editor-jobs-error"));
  find(tree, "panel-audio").props.onClick();
  assert.equal(findProps(h.render(), (props) => !!props.library)?.library.music[0].label, "Recovered music");
  const jobsRetry = find(tree, "editor-jobs-retry");
  jobsRetry.props.onClick(); jobsRetry.props.onClick();
  jobs.resolve([]); await settle(); tree = h.render();
  assert.equal(find(tree, "editor-jobs-error"), undefined);
  assert.deepEqual(reads, { project: 1, library: 2, jobs: 2 });
  h.unmount();
});

test("failed auxiliary refresh preserves loaded library and job results, including an empty successful list", async () => {
  let libraryReads = 0, jobReads = 0;
  const completed = { id: "rendered", project_id: "p", kind: "render", status: "done", progress: 1 };
  const h = pageHarness("../app/editor/[id]/page.tsx", {
    library: async () => { if (++libraryReads === 2) throw new Error("refresh failed"); return { music: [{ id: "keep" }] }; },
    jobs: async () => { if (++jobReads === 2) throw new Error("list refresh failed"); return jobReads === 1 ? [completed] : []; },
  });
  h.render(); await settle(); let tree = h.render();
  find(tree, "editor-library-retry").props.onClick();
  find(tree, "editor-jobs-retry").props.onClick();
  await settle(); tree = h.render();
  assert.match(text(tree), /Kütüphane\s+yenilenemedi/);
  assert.match(text(tree), /İş listesi\s+yenilenemedi/);
  assert.match(text(tree), /Son bilinen veriler korunuyor/);
  find(tree, "panel-subtitles").props.onClick(); tree = h.render();
  const props = findProps(tree, (props) => !!props.library && !!props.jobs);
  assert.equal(props.library.music[0].id, "keep");
  assert.equal(props.jobs.render.id, "rendered");
  find(tree, "editor-jobs-retry").props.onClick();
  await settle(); tree = h.render();
  assert.equal(find(tree, "editor-jobs-error"), undefined);
  assert.deepEqual(Object.keys(findProps(tree, (props) => !!props.library && !!props.jobs).jobs), []);
  h.unmount();
});

test("auxiliary timeout is visible and route changes/unmount abort requests and ignore late data", async () => {
  const timers = [];
  const timeouts = { timeout(ms) { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; },
    any: AbortSignal.any.bind(AbortSignal) };
  let libSignal, jobSignal;
  const h = pageHarness("../app/editor/[id]/page.tsx", {
    library: async (signal) => { libSignal = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); },
    jobs: async (_id, signal) => { jobSignal = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); },
  }, { id: "p" }, { AbortSignal: timeouts });
  h.render(); await settle();
  assert.ok(timers.every(({ ms }) => ms === 15000));
  timers.forEach(({ controller }) => controller.abort(new DOMException("timeout", "TimeoutError")));
  await settle();
  const tree = h.render();
  assert.match(text(find(tree, "editor-library-error")), /zaman aşımına/);
  assert.match(text(find(tree, "editor-jobs-error")), /zaman aşımına/);
  assert.equal(find(tree, "editor-library-retry").props.disabled, false);
  assert.equal(find(tree, "editor-jobs-retry").props.disabled, false);
  assert.ok(libSignal.aborted && jobSignal.aborted);
  h.unmount();

  const oldLibrary = deferred(), oldJobs = deferred(), params = { id: "old" };
  const oldSignals = [];
  let libraryReads = 0;
  const routes = pageHarness("../app/editor/[id]/page.tsx", {
    project: async (id) => ({ ...project(), id }),
    library: async (signal) => { if (++libraryReads === 1) { oldSignals.push(signal); return oldLibrary.promise; } return { music: [{ id: "new-library" }] }; },
    jobs: async (id, signal) => { if (id === "old") { oldSignals.push(signal); return oldJobs.promise; } return []; },
  }, params);
  routes.render(); await settle();
  params.id = "next"; routes.render(); await settle();
  assert.ok(oldSignals.every((signal) => signal.aborted));
  oldLibrary.resolve({ music: [{ id: "old-library" }] });
  oldJobs.resolve([{ id: "old-job", project_id: "old", kind: "render", status: "done" }]);
  await settle();
  find(routes.render(), "panel-subtitles").props.onClick();
  const current = findProps(routes.render(), (props) => !!props.library && !!props.jobs);
  assert.equal(current.library.music[0].id, "new-library");
  assert.deepEqual(Object.keys(current.jobs), []);
  routes.unmount();

  const unmountedSignals = [];
  const unmounted = pageHarness("../app/editor/[id]/page.tsx", {
    library: (signal) => { unmountedSignals.push(signal); return new Promise(() => {}); },
    jobs: (_id, signal) => { unmountedSignals.push(signal); return new Promise(() => {}); },
  });
  unmounted.render(); await settle(); unmounted.unmount();
  assert.equal(unmountedSignals.length, 2);
  assert.ok(unmountedSignals.every((signal) => signal.aborted));
});

test("job refresh restores one watcher and cannot replace a job started or updated after the read began", async () => {
  const stale = deferred(), nextRead = deferred();
  let reads = 0, watches = 0, deliver;
  const active = { id: "active", project_id: "p", kind: "render", status: "running", progress: 0.1 };
  const h = pageHarness("../app/editor/[id]/page.tsx", {
    jobs: async () => { reads++; if (reads === 2) return stale.promise; if (reads === 3) return nextRead.promise; return reads === 4 ? [] : [active]; },
    waitForJob: async (_id, update) => { watches++; deliver = update; return new Promise(() => {}); },
  });
  h.render(); await settle(); let tree = h.render();
  assert.equal(watches, 1);
  find(tree, "editor-jobs-retry").props.onClick();
  deliver({ ...active, progress: 0.8 });
  stale.resolve([{ ...active, progress: 0.2 }]);
  await settle(); tree = h.render();
  find(tree, "panel-export").props.onClick(); tree = h.render();
  let props = findProps(tree, (props) => !!props.jobs && typeof props.track === "function");
  assert.equal(props.jobs.render.progress, 0.8);
  assert.equal(watches, 1);

  // A new job from an actual panel action outranks an older list response of the same kind.
  const newest = { ...active, id: "new-active", progress: 0.05 };
  find(tree, "editor-jobs-retry").props.onClick();
  void props.track(newest);
  nextRead.resolve([active]);
  await settle(); tree = h.render();
  props = findProps(tree, (props) => !!props.jobs && typeof props.track === "function");
  assert.equal(props.jobs.render.id, "new-active");
  assert.equal(watches, 2);
  find(tree, "editor-jobs-retry").props.onClick();
  await settle();
  props = findProps(h.render(), (props) => !!props.jobs && typeof props.track === "function");
  assert.equal(props.jobs.render.id, "new-active", "a bounded recent list must not clear a separately monitored running job");
  assert.equal(watches, 2);
  h.unmount();
});

test("dashboard retry clears a stale error, retains search and prevents overlapping reads", async () => {
  const retry = deferred(); let calls = 0;
  const h = pageHarness("../app/dashboard/page.tsx", { projects: async () => {
    if (++calls === 1) throw new Error("offline");
    return retry.promise;
  } });
  h.render(); await settle(); let tree = h.render();
  assert.match(text(tree), /Projeler yüklenemedi/);
  find(tree, "project-search").props.onChange({ target: { value: "Saved" } });
  const button = find(tree, "dashboard-retry");
  button.props.onClick(); button.props.onClick();
  tree = h.render();
  assert.equal(find(tree, "dashboard-retry").props.disabled, true);
  assert.equal(calls, 2);
  retry.resolve([project()]); await settle(); tree = h.render();
  assert.doesNotMatch(text(tree), /yüklenemedi/);
  assert.equal(find(tree, "project-search").props.value, "Saved");
  assert.ok(find(tree, "open-p")); h.unmount();
});

test("dashboard refresh failure preserves the previous list and recovers on retry", async () => {
  let calls = 0;
  const h = pageHarness("../app/dashboard/page.tsx", { projects: async () => {
    if (++calls === 2) throw new Error("temporary failure");
    return [{ ...project(), status: "generating" }];
  } });
  h.render(); await settle(); h.render();
  await h.timers.at(-1)(); await settle(); let tree = h.render();
  assert.match(text(tree), /Son yüklenen liste gösteriliyor/);
  assert.ok(find(tree, "open-p"));
  await find(tree, "dashboard-retry").props.onClick(); await settle(); tree = h.render();
  assert.doesNotMatch(text(tree), /yenilenemedi/);
  assert.ok(find(tree, "open-p")); h.unmount();
});

test("failed project deletion keeps the card, reports the reason and blocks double submission", async () => {
  const removal = deferred(); let deletes = 0;
  const h = pageHarness("../app/dashboard/page.tsx", { remove: async () => { deletes++; return removal.promise; } });
  h.render(); await settle(); let tree = h.render();
  const button = find(tree, "delete-p");
  const first = button.props.onClick(); await button.props.onClick();
  assert.equal(deletes, 1);
  assert.equal(find(h.render(), "delete-p").props.disabled, true);
  removal.reject(new Error("İşlem sürüyor")); await first; tree = h.render();
  assert.match(text(tree), /Proje silinemedi: İşlem sürüyor/);
  assert.ok(find(tree, "open-p"));
  assert.equal(find(tree, "delete-p").props.disabled, false); h.unmount();
});

test("a stale list refresh cannot bring back a successfully deleted project", async () => {
  const stale = deferred(); let calls = 0, oldSignal;
  const h = pageHarness("../app/dashboard/page.tsx", {
    projects: async (signal) => {
      calls++;
      if (calls === 1) return [{ ...project(), status: "generating" }];
      if (calls === 2) { oldSignal = signal; return stale.promise; }
      return [];
    },
    remove: async () => ({ ok: true }),
  });
  h.render(); await settle(); let tree = h.render();
  const refresh = h.timers.at(-1)();
  await find(tree, "delete-p").props.onClick();
  assert.equal(oldSignal.aborted, true);
  stale.resolve([project()]); await refresh; await settle(); tree = h.render();
  assert.equal(find(tree, "open-p"), undefined);
  assert.match(text(tree), /Henüz proje yok/);
  assert.equal(calls, 3); h.unmount();
});
