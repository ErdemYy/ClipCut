import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/production-review.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports });
const estimate = (patch = {}) => ({ mock: false, video_model: { id: "video-id", label: "Video model" },
  text_model: { id: "text-id", label: "Text model" }, video_calls: 2, video_seconds: 16,
  planning_calls: 0, tts_calls: 2, estimated_usd: 2.4, warnings: [], ...patch });

test("production approval includes exact models, calls, seconds, costs, budget and privacy scope", () => {
  let message;
  assert.equal(exports.approveProduction(estimate(), 3, (value) => { message = value; return true; }), true);
  for (const part of ["video-id", "text-id", "2 çağrı · 16 saniye", "$2.4000", "$3.0000", "kesin fatura değildir", "sağlayıcıya gönderilir"]) {
    assert.ok(message.includes(part), part);
  }
});
test("cancelled approval returns false, without a mutation or retry", () => {
  let confirmations = 0;
  assert.equal(exports.approveProduction(estimate(), undefined, () => { confirmations++; return false; }), false);
  assert.equal(confirmations, 1);
});
test("unknown or exceeded budget and nonfinite limits fail before confirmation", () => {
  const unexpected = () => assert.fail("must not confirm a blocked budget");
  assert.throws(() => exports.approveProduction(estimate(), 1, unexpected), /bütçenizi aşıyor/);
  assert.throws(() => exports.approveProduction(estimate({ estimated_usd: null }), 5, unexpected), /bütçe doğrulanamıyor/);
  assert.throws(() => exports.approveProduction(estimate(), NaN, unexpected), /Geçerli/);
});
test("mock/local assembly needs no paid-production confirmation; unknown unbudgeted prices stay explicit", () => {
  const unexpected = () => assert.fail("local/test request must not show a paid confirmation");
  assert.equal(exports.approveProduction(estimate({ mock: true }), undefined, unexpected), true);
  assert.equal(exports.approveProduction(estimate({ video_calls: 0, tts_calls: 0, estimated_usd: 0 }), undefined, unexpected), true);
  assert.match(exports.productionReviewText(estimate({ estimated_usd: null })), /Bilinmiyor/);
});
