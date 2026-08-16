import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "filter-engine.js"), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox, { filename: "filter-engine.js" });
const filter = sandbox.HuabanFilter;

test("does not reject by image size or aspect ratio", () => {
  assert.equal(filter.classifyMetadata({ width: 120, height: 2000, text: "" }).state, "accepted");
  assert.equal(filter.classifyMetadata({ width: 5000, height: 200, text: "" }).state, "accepted");
});

test("rejects advertising content by default", () => {
  const result = filter.classifyMetadata({ width: 1200, height: 800, text: "限时优惠" });
  assert.equal(result.state, "rejected");
  assert.equal(result.reason, "ad_content");
});

test("accepts copyright materials when intelligent filtering is disabled", () => {
  const byText = filter.classifyMetadata({ text: "版权素材 PNG" }, { enabled: false });
  assert.equal(byText.state, "accepted");
  const byField = filter.classifyMetadata({ isCopyright: true, text: "" }, { enabled: false });
  assert.equal(byField.state, "accepted");
});

test("rejects PSD and paid source-file copyright labels", () => {
  for (const text of ["版权素材 PSD", "PSD 素材下载", "PSD 源文件", "正版素材", "付费素材"]) {
    const result = filter.classifyMetadata({ text });
    assert.equal(result.state, "rejected", text);
    assert.equal(result.reason, "copyright_material", text);
  }
});

test("rejects strong ads whenever filtering is enabled", () => {
  const result = filter.classifyMetadata({ width: 1200, height: 300, text: "限时优惠 立即购买 领券下单 99元" });
  assert.equal(result.state, "rejected");
  assert.equal(result.reason, "ad_content");
});

test("rejects isolated transparent assets and keeps full compositions", () => {
  assert.equal(filter.classifyPixels({ alphaRatio: 0.32, subjectRatio: 0.45 }).reason, "transparent_asset");
  assert.equal(filter.classifyPixels({ alphaRatio: 0.20, subjectRatio: 0.92 }).state, "suspicious");
  assert.equal(filter.classifyPixels({ alphaRatio: 0.02, subjectRatio: 0.92 }).state, "accepted");
});

test("keeps images selected when pixel decoding fails", () => {
  const result = filter.classifyPixels({ decodeFailed: true, error: "HTTP 403" });
  assert.equal(result.state, "accepted");
  assert.equal(result.reason, "decode_failed");
});

test("detects only near-identical perceptual hashes as visual duplicates", () => {
  const original = "0".repeat(64);
  assert.equal(filter.isVisualDuplicate("1" + "0".repeat(63), [original]), true);
  assert.equal(filter.isVisualDuplicate("111" + "0".repeat(61), [original]), false);
});
