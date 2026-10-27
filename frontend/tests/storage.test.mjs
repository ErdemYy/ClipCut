import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017,
  } }).outputText;
  const exported = {};
  vm.runInNewContext(js, { exports: exported, require(name) { throw new Error(`Unexpected import ${name}`); } });
  return exported;
}
const { formatBytes, formatMinAge, storageProtectionSummary } = load("../lib/storage.ts");

test("formatBytes uses readable binary units without hiding small files", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
  assert.equal(formatBytes(1024 ** 3), "1 GB");
});

test("formatMinAge describes the server safety window", () => {
  assert.equal(formatMinAge(0), "1 dakika");
  assert.equal(formatMinAge(60), "1 dakika");
  assert.equal(formatMinAge(1800), "30 dakika");
  assert.equal(formatMinAge(3600), "1 saat");
  assert.equal(formatMinAge(7200), "2 saat");
  assert.equal(formatMinAge(86400), "1 gün");
  assert.equal(formatMinAge(Number.NaN), "1 dakika");
});

test("storageProtectionSummary groups reasons and labels unknown ones", () => {
  const dir = (reason) => ({ token: "a".repeat(32), bytes: 1, files: 1, age_seconds: 7200, reason });
  assert.equal(storageProtectionSummary([]), "");
  assert.equal(storageProtectionSummary([dir("referenced"), dir("referenced"), dir("recent")]),
    "2 iş sonuçlarında kullanılıyor · 1 yeni oluşturuldu");
  assert.equal(storageProtectionSummary([dir("mystery")]), "1 mystery");
});
