import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { webcrypto } from "node:crypto";

const code = ts.transpileModule(fs.readFileSync(new URL("../lib/api.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(fetch, extra = {}) {
  const exports = {};
  const delays = [];
  vm.runInNewContext(code, { exports, process: { env: {} }, fetch, FormData, TypeError, DOMException,
    crypto: webcrypto, TextEncoder, AbortSignal, setTimeout(fn, ms) { delays.push(ms); return setTimeout(fn, 0); }, clearTimeout, ...extra });
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

test("library, media and panel reads forward cancellation without mutation headers", async () => {
  const controller = new AbortController();
  const calls = [];
  const api = harness(async (url, init) => { calls.push({ url, init }); return response([]); });
  await api.api.library(controller.signal);
  await api.api.jobs("p", controller.signal);
  await api.api.templates(controller.signal);
  await api.api.voices(controller.signal);
  await api.api.brollLibrary(controller.signal);
  await api.api.projectAudio("p", controller.signal);
  await api.api.timeline("p", controller.signal);
  await api.api.waveform("p", controller.signal);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(({ init }) => init.signal === controller.signal && !init.method && !init.headers["Idempotency-Key"]));
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

const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key), values };
};

test("simultaneous identical mutations coalesce into one request, later intentional action gets a new key", async () => {
  const calls = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const api = harness(async (_url, init) => {
    calls.push(init);
    if (calls.length === 1) await pending;
    return response(job("done"));
  });
  const first = api.api.render("p"), second = api.api.render("p");
  while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a.id, b.id);
  assert.match(calls[0].headers["Idempotency-Key"], /^[a-f0-9-]{36}$/);
  await api.api.render("p");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
});

test("single-flight is reserved before asynchronous fingerprint work", async () => {
  let hashes = 0, sends = 0;
  const api = harness(async () => { sends++; return response(job("done")); }, {
    crypto: { randomUUID: () => webcrypto.randomUUID(), subtle: { async digest(...args) {
      hashes++;
      await new Promise((resolve) => setImmediate(resolve));
      return webcrypto.subtle.digest(...args);
    } } },
  });
  await Promise.all([api.api.render("p"), api.api.render("p")]);
  assert.equal(hashes, 1);
  assert.equal(sends, 1);
});

test("lost mutation response retains key for manual retry even after page reload, without storing prompts", async () => {
  const sessionStorage = memoryStorage();
  let originalKey;
  const first = harness(async (_url, init) => {
    originalKey = init.headers["Idempotency-Key"];
    throw new TypeError("offline");
  }, { sessionStorage });
  const body = { prompt: "PRIVATE PROMPT", duration: 8, aspect_ratio: "16:9" };
  await assert.rejects(first.api.generate(body), /offline/);
  assert.equal(sessionStorage.values.size, 1);
  assert.ok(!JSON.stringify([...sessionStorage.values]).includes("PRIVATE PROMPT"));
  const reloaded = harness(async (_url, init) => {
    assert.equal(init.headers["Idempotency-Key"], originalKey);
    return response({ project: { id: "saved" }, job: job("done") });
  }, { sessionStorage });
  assert.equal((await reloaded.api.generate(body)).project.id, "saved");
  assert.equal(sessionStorage.values.size, 0);
});

test("pending and 5xx responses keep the same key; ordinary validation failures allow a fresh action", async () => {
  const keys = [];
  let status = 503;
  const api = harness(async (_url, init) => {
    keys.push(init.headers["Idempotency-Key"]);
    return new Response(JSON.stringify({ detail: "not completed" }), {
      status, headers: { "Idempotency-Status": status === 409 ? "pending" : "completed" },
    });
  });
  await assert.rejects(api.api.render("p"));
  status = 409;
  await assert.rejects(api.api.render("p"));
  assert.equal(keys[0], keys[1]);
  status = 422;
  await assert.rejects(api.api.render("p"));
  assert.equal(keys[1], keys[2]);
  await assert.rejects(api.api.render("p"));
  assert.notEqual(keys[2], keys[3]);
});

test("different payloads never reuse a key, reads/preflight/checks never reserve one", async () => {
  const calls = [];
  const api = harness(async (url, init) => {
    calls.push({ url, init });
    return response({});
  });
  await api.api.render("p", { resolution: "720p", quality: "fast" });
  await api.api.render("p", { resolution: "1080p", quality: "fast" });
  await api.api.project("p");
  await api.api.preflight({});
  await api.api.checkAiConnection();
  assert.notEqual(calls[0].init.headers["Idempotency-Key"], calls[1].init.headers["Idempotency-Key"]);
  assert.ok(calls.slice(2).every(({ init }) => !init.headers["Idempotency-Key"]));
});

test("all new editor mutations carry their displayed edit revision", async () => {
  const calls = [];
  const api = harness(async (_url, init) => { calls.push(JSON.parse(init.body)); return response({}); });
  const revision = "a".repeat(64);
  await api.api.applyTemplate("p", "template", revision);
  await api.api.edit("p", "edit", revision);
  await api.api.undo("p", revision);
  await api.api.applyVoiceover("p", { text: "hi", voice: "voice", revision });
  await api.api.deleteVoiceover("p", revision);
  await api.api.applyAutoBroll("p", revision);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((body) => body.revision === revision));
  for (const [file, pattern] of [
    ["TemplatesPanel", /api\.applyTemplate\(project\.id, tmpl\.id, project\.edit_revision\)/],
    ["BrollPanel", /api\.applyAutoBroll\(project\.id, project\.edit_revision\)/],
    ["VoiceoverPanel", /revision: project\.edit_revision/],
    ["EditPanel", /api\.edit\(project\.id, text\.trim\(\), project\.edit_revision\)/],
    ["Timeline", /api\.undo\(project\.id, project\.edit_revision\)/],
    ["TranscriptPanel", /api\.undo\(project\.id, project\.edit_revision\)/],
  ]) assert.match(fs.readFileSync(new URL(`../components/editor/${file}.tsx`, import.meta.url), "utf8"), pattern);
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
    if (name === "@/lib/use-read-list") return { useReadList: () => ({ items: [], loaded: true, pending: false, error: null }) };
    if (name === "./ReadListStatus") return { default: () => null };
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
