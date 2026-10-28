import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(api, file = "../components/AIConnectionPanel.tsx") {
  const hooks = [], effects = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, AbortController, AbortSignal, require(name) {
    if (name === "react") return {
      useState(initial) {
        const index = cursor++;
        if (!hooks[index]) hooks[index] = { value: initial };
        return [hooks[index].value, (next) => { hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; }];
      },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useCallback(fn, deps) {
        const index = cursor++;
        if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, fn };
        return hooks[index].fn;
      },
      useEffect(fn, deps) {
        const index = cursor++;
        if (!hooks[index] || !same(hooks[index].deps, deps)) {
          hooks[index]?.cleanup?.(); hooks[index] = { deps };
          effects.push(() => { hooks[index].cleanup = fn(); });
        }
      },
    };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@/lib/api") return { api };
    if (name === "next/navigation") return { usePathname: () => "/create" };
    if (name === "next/link") return { default: () => null };
    if (name.endsWith(".css")) return { default: {} };
    throw new Error(`Unexpected import ${name}`);
  } });
  return {
    render() { cursor = 0; const tree = exports.default(); effects.splice(0).forEach((fn) => fn()); return tree; },
    unmount() { hooks.forEach((hook) => hook?.cleanup?.()); },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function find(node, id) {
  if (!node || typeof node !== "object") return;
  if (node.props?.id === id) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, id)).find(Boolean);
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" ? [node.props?.children].flat(Infinity).map(text).join(" ") : "";
}
const report = (status = "unchecked") => ({ status, mode: "real", key_configured: true, can_check: true,
  checked_at: null, message: "Anahtar tanımlı; henüz kontrol edilmedi.", scope_note: "Üretim başarısı garanti edilmez.",
  models: [{ role: "video", id: "video-model", status: "unchecked", message: "Henüz kontrol edilmedi.", catalog_status: null }],
});

test("panel load only reads local configuration; explicit click checks once and shows scope", async () => {
  let reads = 0, checks = 0, finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness({ aiConnection: async () => { reads++; return report(); },
    checkAiConnection: async () => { checks++; return pending; } });
  h.render(); await settle(); let tree = h.render();
  assert.equal(reads, 1); assert.equal(checks, 0);
  assert.match(text(tree), /Kontrol edilmedi/);
  const button = find(tree, "ai-connection-check");
  button.props.onClick(); button.props.onClick();
  assert.equal(checks, 1);
  assert.equal(find(h.render(), "ai-connection-check").props.disabled, true);
  finish({ ...report("checked"), checked_at: "2026-10-28T12:00:00Z", message: "Model bilgisine erişildi." });
  await settle(); tree = h.render();
  assert.match(text(tree), /Model bilgileri doğrulandı/);
  assert.match(text(tree), /garanti edilmez/);
  assert.doesNotMatch(text(tree), /Gemini hazır/);
  h.unmount();
});

test("missing-key and test states only offer a local reload, not a provider check", async () => {
  for (const status of ["missing_key", "test"]) {
    let checks = 0, reads = 0;
    const h = harness({ aiConnection: async () => { reads++; return { ...report(status), can_check: false, key_configured: false }; },
      checkAiConnection: async () => { checks++; } });
    h.render(); await settle(); let tree = h.render();
    assert.equal(find(tree, "ai-connection-check"), undefined);
    assert.match(text(tree), /GEMINI_API_KEY/);
    assert.match(text(tree), /MOCK_AI=false/);
    find(tree, "ai-connection-reload").props.onClick(); await settle(); tree = h.render();
    assert.equal(reads, 2); assert.equal(checks, 0);
    assert.match(text(tree), /anahtarsız kullanılabilir/);
    h.unmount();
  }
});

test("a failed check is visible and never auto-retried or misrepresented as verified", async () => {
  let checks = 0;
  const h = harness({ aiConnection: async () => report(), checkAiConnection: async () => {
    checks++; throw new DOMException("timeout", "TimeoutError");
  } });
  h.render(); await settle();
  find(h.render(), "ai-connection-check").props.onClick(); await settle();
  const tree = h.render();
  assert.match(text(tree), /zaman aşımına uğradı/);
  assert.equal(checks, 1);
  assert.doesNotMatch(text(tree), /Model bilgileri doğrulandı/);
  assert.ok(find(tree, "ai-connection-reload")); h.unmount();
});

test("unmount aborts monitoring and ignores a late connection result", async () => {
  let signal, finish;
  const h = harness({ aiConnection: async (value) => { signal = value; return new Promise((resolve) => { finish = resolve; }); } });
  h.render(); await settle(); h.unmount();
  assert.equal(signal.aborted, true);
  finish(report("checked")); await settle();
  assert.doesNotMatch(text(h.render()), /Model bilgileri doğrulandı/);
});

test("Navbar never calls a configured key a verified AI connection", async () => {
  for (const ai_key_configured of [true, false, undefined]) {
    const h = harness({ health: async () => ({ mock: false, ai_key_configured }) }, "../components/Navbar.tsx");
    h.render(); await settle(); const value = text(h.render());
    assert.doesNotMatch(value, /Gemini hazır|Gemini bağlı/);
    assert.match(value, ai_key_configured === false ? /AI anahtarı yok/ : /AI yapılandırıldı/);
    h.unmount();
  }
});
