import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (path) => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const helpers = {};
vm.runInNewContext(compile("../lib/clip-trim.ts"), { exports: helpers });
const componentCode = compile("../components/editor/ClipRangeStrip.tsx");

// A minimal hook/JSX harness exercises the actual component event handlers.
// This is not a browser layout, pointer-capture or accessibility audit.
function harness() {
  const slots = [];
  let cursor = 0;
  let range = { start: 20, end: 55 };
  const commits = [];
  let disabled = false;
  const jsx = (type, props) => ({ type, props });
  const react = {
    memo: (component) => component,
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next) => { slots[index] = next; }];
    },
  };
  const exported = {};
  vm.runInNewContext(componentCode, { exports: exported, require(name) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@/lib/clip-trim") return helpers;
    if (name === "@/lib/api") return { formatTime: String };
    if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) };
    throw new Error(`Unexpected import ${name}`);
  } });
  function nodes(node) {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  }
  function render() {
    cursor = 0;
    const tree = exported.default({ label: "1. aday", duration: 100, range, disabled,
      onChange(next) { range = next; }, onCommit(next, action) { commits.push({ ...next, action }); } });
    const all = nodes(tree);
    for (const node of all) {
      if (node.props?.ref) node.props.ref.current = { getBoundingClientRect: () => ({ width: 700 }) };
    }
    return all;
  }
  const target = { focus() {}, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const event = (extra = {}) => ({ button: 0, pointerId: 1, clientX: 0, currentTarget: target,
    preventDefault() {}, ...extra });
  const slider = (name) => render().find((node) => node.props?.["aria-label"] === `1. aday ${name}`);
  return { render, slider, event, commits, get range() { return range; }, setDisabled(value) { disabled = value; } };
}

test("whole-range slider translates, commits once, and exposes its start and duration", () => {
  const h = harness();
  const slider = h.slider("aralığı taşı");
  assert.equal(slider.props["aria-valuemax"], 65);
  assert.equal(slider.props["aria-valuenow"], 20);
  assert.match(slider.props["aria-valuetext"], /35.0/);
  slider.props.onPointerDown(h.event());
  // Frozen view is 0..85, so 70px over a 700px track moves 8.5s.
  slider.props.onPointerMove(h.event({ clientX: 70 }));
  assert.equal(h.range.start, 28.5);
  assert.equal(h.range.end, 63.5);
  slider.props.onPointerUp(h.event({ clientX: 70 }));
  slider.props.onLostPointerCapture(h.event());
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].action, "move");
});

for (const cancel of ["onPointerCancel", "onLostPointerCapture", "Escape"]) {
  test(`whole-range ${cancel} restores both endpoints without committing`, () => {
    const h = harness();
    const slider = h.slider("aralığı taşı");
    slider.props.onPointerDown(h.event());
    slider.props.onPointerMove(h.event({ clientX: 70 }));
    if (cancel === "Escape") slider.props.onKeyDown(h.event({ key: "Escape" }));
    else slider.props[cancel](h.event());
    assert.equal(h.range.start, 20);
    assert.equal(h.range.end, 55);
    assert.equal(h.commits.length, 0);
  });
}

test("whole-range keyboard uses relative steps and full-source Home/End; buttons offer a drag alternative", () => {
  const h = harness();
  h.slider("aralığı taşı").props.onKeyDown(h.event({ key: "ArrowRight" }));
  assert.equal(h.range.start, 20.1);
  h.slider("aralığı taşı").props.onKeyDown(h.event({ key: "ArrowLeft", shiftKey: true }));
  assert.equal(h.range.start, 19.1);
  h.slider("aralığı taşı").props.onKeyDown(h.event({ key: "End" }));
  assert.equal(h.range.start, 65);
  assert.equal(h.range.end, 100);
  h.slider("aralığı taşı").props.onKeyDown(h.event({ key: "Home" }));
  assert.equal(h.range.start, 0);
  assert.equal(h.range.end, 35);
  const later = h.render().find((node) => node.props?.children === "1 sn geçe taşı");
  later.props.onClick();
  assert.equal(h.range.start, 1);
  assert.equal(h.range.end, 36);
  h.setDisabled(true);
  h.slider("aralığı taşı").props.onKeyDown(h.event({ key: "End" }));
  assert.equal(h.range.start, 1);
});

test("edge handles still resize and emit the edge rather than a whole-range action", () => {
  const h = harness();
  h.slider("bitiş tutamacı").props.onKeyDown(h.event({ key: "ArrowRight" }));
  assert.equal(h.range.start, 20);
  assert.equal(h.range.end, 55.1);
  assert.equal(h.commits[0].action, "end");
});

test("pointer movement is limited to its frozen window and ignores other pointers", () => {
  const h = harness();
  const slider = h.slider("aralığı taşı");
  slider.props.onPointerDown(h.event());
  slider.props.onPointerMove(h.event({ pointerId: 2, clientX: 7000 }));
  assert.equal(h.range.start, 20);
  slider.props.onPointerMove(h.event({ clientX: 7000 }));
  assert.equal(h.range.start, 50);
  assert.equal(h.range.end, 85);
  slider.props.onPointerUp(h.event({ clientX: 7000 }));
  assert.equal(h.commits.length, 1);
});

test("click without movement does not commit and disabled controls cannot begin dragging", () => {
  const h = harness();
  let slider = h.slider("aralığı taşı");
  slider.props.onPointerDown(h.event());
  slider.props.onPointerUp(h.event());
  assert.equal(h.commits.length, 0);
  h.setDisabled(true);
  slider = h.slider("aralığı taşı");
  slider.props.onPointerDown(h.event());
  slider.props.onPointerMove(h.event({ clientX: 70 }));
  slider.props.onPointerUp(h.event({ clientX: 70 }));
  assert.equal(h.range.start, 20);
  assert.equal(h.commits.length, 0);
});
