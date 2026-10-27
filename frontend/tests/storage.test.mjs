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
const {
  formatBytes, formatMinAge, formatTrashExpiry, renderProtectionSummary, storageCategoryLabel,
  storageProtectionSummary, storageTrashLabel, storageUsageSummary, trashBatches, workProtectionSummary,
} = load("../lib/storage.ts");

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

test("storageCategoryLabel covers the server categories and leaves unknowns visible", () => {
  assert.equal(storageCategoryLabel("source"), "Kaynak medya");
  assert.equal(storageCategoryLabel("renders"), "Ana render MP4'leri");
  assert.equal(storageCategoryLabel("staging"), "Hazırlama çıktıları");
  assert.equal(storageCategoryLabel("previews"), "Önizlemeler");
  assert.equal(storageCategoryLabel("work"), "work/ ara dosyaları");
  assert.equal(storageCategoryLabel("trash"), "Çöp kutusu");
  assert.equal(storageCategoryLabel("other"), "Diğer proje dosyaları");
  assert.equal(storageCategoryLabel("mystery"), "mystery");
});

test("renderProtectionSummary explains why old main renders stay", () => {
  const render = (reason) => ({ file: "clipcut_20260101_120000_aaaaaaaa.mp4", bytes: 1, age_seconds: 7200, reason });
  assert.equal(renderProtectionSummary([]), "");
  assert.equal(renderProtectionSummary([render("referenced"), render("recent"), render("recent")]),
    "1 proje veya iş sonucunda kullanılıyor · 2 yeni oluşturuldu");
  assert.equal(renderProtectionSummary([render("mystery")]), "1 mystery");
});

test("storageUsageSummary separates moveable and already-trashed bytes", () => {
  assert.equal(storageUsageSummary(0, 0, 0), "Toplam 0 B · 0 B çöpe taşınabilir · 0 B çöpte.");
  assert.equal(storageUsageSummary(1536, 1024, 512),
    "Toplam 1.5 KB · 1 KB çöpe taşınabilir · 512 B çöpte.");
  assert.equal(storageUsageSummary(Number.NaN, -5, Number.NaN),
    "Toplam 0 B · 0 B çöpe taşınabilir · 0 B çöpte.");
});

test("storageTrashLabel keeps render names and abbreviates staging tokens", () => {
  assert.equal(storageTrashLabel({ kind: "render", name: "clipcut_20260101_120000_aaaaaaaa.mp4" }),
    "clipcut_20260101_120000_aaaaaaaa.mp4");
  assert.equal(storageTrashLabel({ kind: "staging", name: "a".repeat(32) }),
    "Hazırlama · aaaaaaaa…");
  assert.equal(storageTrashLabel({ kind: "work_render", name: "20261021_210709" }),
    "Çalışma · 20261021_210709");
  assert.equal(storageTrashLabel({ kind: "work_publish", name: "d".repeat(32) }),
    "Yayın çalışması · dddddddd…");
  assert.equal(storageTrashLabel({ kind: "work_preview", name: "b".repeat(32) }),
    "Önizleme çalışması · bbbbbbbb…");
  assert.equal(storageTrashLabel({ kind: "work_clip_preview", name: "c".repeat(32) }),
    "Klip önizlemesi · cccccccc…");
  assert.equal(storageTrashLabel({ kind: "work_waveforms", name: "waveforms" }),
    "Dalga formu önbelleği");
});

test("workProtectionSummary groups scratch protection reasons", () => {
  const item = (reason) => ({
    kind: "work_render", name: "20261021_210709", bytes: 1, files: 1, age_seconds: 7200, reason,
  });
  assert.equal(workProtectionSummary([]), "");
  assert.equal(workProtectionSummary([item("recent"), item("recent"), item("nested")]),
    "2 yeni oluşturuldu · 1 alt klasör içeriyor");
});

test("formatTrashExpiry turns remaining seconds into a readable countdown", () => {
  assert.equal(formatTrashExpiry(0), "Süresi doldu");
  assert.equal(formatTrashExpiry(-1), "Süresi doldu");
  assert.equal(formatTrashExpiry(Number.NaN), "Süresi doldu");
  assert.equal(formatTrashExpiry(60), "1 dakika kaldı");
  assert.equal(formatTrashExpiry(3600), "1 saat kaldı");
  assert.equal(formatTrashExpiry(7200), "2 saat kaldı");
  assert.equal(formatTrashExpiry(86400), "1 gün kaldı");
  assert.equal(formatTrashExpiry(604800), "7 gün kaldı");
});

test("trashBatches groups a cleanup by batch, sums bytes and puts newest first", () => {
  const item = (id, batch, age, bytes) => ({
    id, kind: "render", name: id, bytes, files: 1, deleted_at: "2026-10-27T00:00:00+00:00",
    batch_id: batch, age_seconds: age, expires_in_seconds: 604800 - age,
  });
  const batches = trashBatches([
    item("old-a", "a".repeat(32), 100, 10),
    item("newer-b", "b".repeat(32), 10, 20),
    item("old-b", "a".repeat(32), 200, 30),
    item("single", null, 5, 40),
  ]);
  assert.equal(batches.map((batch) => batch.id).join(","), "entry:single," + "b".repeat(32) + "," + "a".repeat(32));
  assert.equal(batches[2].bytes, 40);
  assert.equal(batches[2].entries.map((entry) => entry.id).join(","), "old-a,old-b");
});
