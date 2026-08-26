import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../content.js", import.meta.url), "utf8");

test("Huaban pin detail removes the image action bar", () => {
  assert.match(source, /function removePinDetailImageActions\(\)/);
  assert.match(source, /document\.querySelectorAll\("\.hc-huaban-btns"\)/);
  assert.match(source, /node\.hidden = true/);
  assert.match(source, /node\.style\.setProperty\("display", "none", "important"\)/);
  assert.match(source, /\["\u590d\u5236\u56fe\u7247", "\u4e0b\u8f7d\u56fe\u7247", "\u4fdd\u5b58\u5230Eagle"\]/);
  assert.match(source, /removePinDetailImageActions\(\);[\s\S]*?addMainPinOverlay\(currentPinData\)/);
});

test("Huaban action bar stays hidden when the other extension reinjects it", async () => {
  const css = await readFile(new URL("../styles/overlay.css", import.meta.url), "utf8");
  assert.match(css, /\.hc-huaban-btns\s*\{[\s\S]*?display:\s*none\s*!important/);
  assert.match(css, /\.hc-huaban-btns\s*\{[\s\S]*?pointer-events:\s*none\s*!important/);
});

test("Huaban detail main image reuses the homepage card overlay implementation", () => {
  assert.match(source, /function addPinOverlayToCard\(pin, card\)/);
  assert.match(source, /function addMainPinOverlay\(pin\)[\s\S]*?return addPinOverlayToCard\(pin, mainPinCardForImage\(img\)\)/);
  assert.match(source, /matched \+= addPinOverlayToCard\(pin, hrefMap\[String\(pin\.pin_id\)\]\)/);
  assert.match(source, /directPinCards\.set\(pid, card\)/);
});
