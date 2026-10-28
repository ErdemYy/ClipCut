import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(fs.readFileSync(new URL("../lib/api.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(fetch, extra = {}) {
  const exports = {};
  const delays = [];
  vm.runInNewContext(code, { exports, process: { env: {} }, fetch, FormData, TypeError, DOMException,
    AbortSignal, setTimeout(fn, ms) { delays.push(ms); return setTimeout(fn, 0); }, clearTimeout, ...extra });
  return { ...exports, delays };
}

const job = (status) => ({ id: "j1", kind: "render", status });
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

test("job reads recover from offline/503 errors without resubmitting work", async () => {
  const calls = [];
  const queue = [new TypeError("offline"), response({ detail: "restart" }, 503), response(job("running")), response(job("done"))];
  const api = harness(async (url, init) => {
    calls.push({ url, method: init.method ?? "GET" });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const states = [], connection = [];
  const final = await api.waitForJob("j1", (j) => states.push(j.status), 25, {
    onConnectionChange: (value) => connection.push(value),
  });
  assert.equal(final.status, "done");
  assert.deepEqual(states, ["running", "done"]);
  assert.deepEqual(connection, [false, true]);
  assert.deepEqual(api.delays, [1000, 2000, 25]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.method === "GET" && call.url.endsWith("/api/jobs/j1")));
});

test("404/403 are terminal rather than retried forever", async () => {
  for (const status of [404, 403]) {
    let calls = 0;
    const api = harness(async () => { calls++; return response({ detail: "gone" }, status); });
    await assert.rejects(api.waitForJob("j1", () => {}), (error) => error.status === status && error.message === "gone");
    assert.equal(calls, 1);
  }
});

test("429 retries and failed terminal job returns without resubmission", async () => {
  const queue = [response({ detail: "busy" }, 429), response(job("failed"))];
  const api = harness(async () => queue.shift());
  assert.equal((await api.waitForJob("j1", () => {})).status, "failed");
  assert.equal(queue.length, 0);
});

test("poll abort during backoff stops further reads", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = harness(async () => { calls++; throw new TypeError("offline"); }, {
    setTimeout() { queueMicrotask(() => controller.abort()); return 1; }, clearTimeout() {},
  });
  await assert.rejects(api.waitForJob("j1", () => {}, 1000, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("poll abort in-flight cancels the request without delivering an update", async () => {
  const controller = new AbortController();
  const api = harness(async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    controller.abort();
  }));
  await assert.rejects(api.waitForJob("j1", () => assert.fail("aborted update"), 1000,
    { signal: controller.signal }), { name: "AbortError" });
});

test("a timed-out job read retries, but callback errors are not retried", async () => {
  let calls = 0;
  const api = harness(async () => {
    if (++calls === 1) throw new DOMException("timed out", "TimeoutError");
    return response(job("done"));
  });
  assert.equal((await api.waitForJob("j1", () => {})).status, "done");
  const other = harness(async () => response(job("running")));
  await assert.rejects(other.waitForJob("j1", () => { throw new Error("callback failed"); }), /callback failed/);
  assert.equal(other.delays.length, 0);
});

test("mutation error keeps plain-text server message and is never auto-retried", async () => {
  let calls = 0;
  const api = harness(async () => { calls++; return new Response("İşlem zaten sürüyor", { status: 409 }); });
  await assert.rejects(api.api.render("project"), (error) => error.status === 409 && error.message === "İşlem zaten sürüyor");
  assert.equal(calls, 1);
});

test("all full-plan save callers send their displayed revision", async () => {
  let sent;
  const api = harness(async (_url, init) => { sent = JSON.parse(init.body); return response({ id: "p" }); });
  await api.api.setPlan("p", { operations: [] }, "revision-value");
  assert.equal(sent.revision, "revision-value");
  for (const component of ["AudioPanel", "SubtitlePanel", "BrollPanel", "EditPanel"]) {
    const src = fs.readFileSync(new URL(`../components/editor/${component}.tsx`, import.meta.url), "utf8");
    assert.match(src, /api\.setPlan\([^;]*project\.render_revision/);
  }
});

test("audio save failure does not publish an unsaved plan or a success notification", async () => {
  const src = fs.readFileSync(new URL("../components/editor/AudioPanel.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(src, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {}, saved = [], messages = [], calls = [];
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === "react") return {
      useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }), useEffect: () => {},
    };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@/lib/api") return { api: { setPlan: async (...args) => {
      calls.push(args); throw new Error("offline");
    } } };
    if (name.endsWith(".css")) return { default: {} };
    throw new Error(`Unexpected import ${name}`);
  } });
  const tree = exports.default({ project: { id: "p", plan: { operations: [] }, render_revision: "rev" },
    setProject: (p) => saved.push(p), notify: (...args) => messages.push(args),
    library: { music: [], sfx: [{ id: "ding", label: "Ding" }] },
  });
  function find(node, id) {
    if (!node || typeof node !== "object") return;
    if (node.props?.id === id) return node;
    const children = [node.props?.children].flat(Infinity);
    return children.map((child) => find(child, id)).find(Boolean);
  }
  await find(tree, "sfx-add-ding").props.onClick();
  assert.equal(saved.length, 0);
  assert.equal(calls[0][2], "rev");
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], "offline");
  assert.equal(messages[0][1], true);
});
