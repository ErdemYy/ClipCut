import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual pages with a small deterministic hook runtime, not source matches.
function pageHarness(file, api, params = { id: "p" }) {
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
      if (name === "@/lib/api") return { api: { ...defaults, ...api }, formatTime: () => "0:06", mediaUrl: (p) => p, downloadUrl: (p) => p };
      if (name === "@/lib/render-preview") return { mainRenderFreshness: () => "missing", mainRenderMessage: () => null };
      if (name === "next/link" || name.startsWith("@/components/")) return { default: () => null };
      if (name.endsWith(".css")) return { default: {} };
      throw new Error(`Unexpected import ${name}`);
    },
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
