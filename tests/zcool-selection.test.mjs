import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../zcool-content.js", import.meta.url), "utf8");
const overlayStyle = await readFile(new URL("../styles/overlay.css", import.meta.url), "utf8");

test("ZCOOL preview selection badge updates without rebuilding its text node", () => {
  assert.match(source, /if \(badge\.textContent !== badgeText\) badge\.textContent = badgeText/);
  assert.match(source, /badge\.dataset\.zcoolBound !== "1"/);
  assert.match(source, /badge\.dataset\.zcoolBound = "1"/);
});

test("ZCOOL reused preview nodes toggle the currently displayed media in manual mode", () => {
  assert.match(source, /overlay\.dataset\.zcoolId = record\.id/);
  assert.match(source, /badge\.dataset\.zcoolId = record\.id/);
  assert.match(source, /var currentId = badge\.dataset\.zcoolId/);
  assert.match(source, /var currentRecord = works\.get\(currentId\)/);
  assert.match(source, /selected\.set\(currentId, choose\)/);
  assert.match(source, /decorate\(currentRecord\); updateCount\(\)/);
});

test("ZCOOL gives every media id an independent layer and visual selection state", () => {
  assert.match(source, /function directCollectorChild\(host, className, recordId\)/);
  assert.match(source, /directCollectorChild\(host, "zcool-dl-image-layer", record\.id\)/);
  assert.match(source, /directCollectorChild\(host, "huaban-dl-badge", record\.id\)/);
  assert.match(source, /overlay\.classList\.toggle\("zcool-dl-selected", isSelected\)/);
  assert.match(source, /badge\.classList\.toggle\("zcool-dl-selected", isSelected\)/);
  assert.match(overlayStyle, /\.zcool-dl-image-layer\.zcool-dl-selected[\s\S]*?border:\s*3px solid #22c55e !important/);
  assert.match(overlayStyle, /\.zcool-dl-badge\.zcool-dl-selected[\s\S]*?color:\s*#fff !important[\s\S]*?background:\s*#22c55e !important/);
});

test("ZCOOL keeps media-bound selection controls mounted while scrolling", () => {
  assert.match(source, /overlay\.style\.display = "block"/);
  assert.match(source, /badge\.style\.display = "flex"/);
  assert.doesNotMatch(source, /rect\.bottom > 0 && rect\.top < innerHeight/);
});
