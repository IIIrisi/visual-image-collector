import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "xhs-content.js"), "utf8");
const overlayStyle = await readFile(join(root, "styles", "overlay.css"), "utf8");
const slideFunction = source.match(/  function currentSlideIndex\(requireActuallyVisible\) \{[\s\S]*?\n  \}\n\n  function mediaSemantics/);
assert.ok(slideFunction, "currentSlideIndex implementation must remain extractable");
const functionSource = slideFunction[0].replace(/\n\n  function mediaSemantics$/, "");
const liveFunctions = source.match(/  function liveHostForElement\(element\) \{[\s\S]*?\n  function candidateScore/);
assert.ok(liveFunctions, "Live host selection functions must remain extractable");
const liveFunctionSource = liveFunctions[0].replace(/\n  function candidateScore$/, "");

function counter(text, rect, parentElement = null, style = {}) {
  return {
    textContent: text,
    childElementCount: 0,
    parentElement,
    getBoundingClientRect() { return rect; },
    getAttribute(name) { return name === "aria-hidden" ? this.ariaHidden || null : null; },
    style: { display: "block", visibility: "visible", opacity: "1", ...style }
  };
}

test("Live slide lookup ignores retained hidden counters and returns the actually visible page", () => {
  const hiddenParent = counter("", { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 });
  hiddenParent.ariaHidden = "true";
  const stale = counter("1/5", { left: 850, top: 100, right: 900, bottom: 130, width: 50, height: 30 }, hiddenParent);
  const visibleParent = counter("", { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 });
  const current = counter("4/5", { left: 850, top: 100, right: 900, bottom: 130, width: 50, height: 30 }, visibleParent);
  const context = {
    result: 0,
    innerWidth: 1200,
    innerHeight: 800,
    document: { querySelectorAll() { return [stale, current]; } },
    getComputedStyle(element) { return element.style; },
    Array, Number, String
  };

  vm.runInNewContext(`${functionSource}\nresult = currentSlideIndex(true);`, context);
  assert.equal(context.result, 4);
  vm.runInNewContext(`${functionSource}\nresult = currentSlideIndex(false);`, context);
  assert.equal(context.result, 1, "ordinary-media lookup remains on the previous behavior");
});

function liveNode(tagName, source) {
  return {
    tagName,
    currentSrc: source,
    src: source,
    parentElement: null,
    score: 100,
    getBoundingClientRect() { return { left: 300, top: 100, right: 800, bottom: 800, width: 500, height: 700 }; }
  };
}

function liveHost(index) {
  const slide = {
    className: "swiper-slide",
    parentElement: null,
    style: { display: "block", visibility: "visible", opacity: "1" },
    getAttribute() { return null; },
    getBoundingClientRect() { return { left: 250, top: 80, right: 850, bottom: 820, width: 600, height: 740 }; }
  };
  const image = liveNode("IMG", `https://sns-img.example.xhscdn.com/live-cover-${index}.webp`);
  const host = {
    className: "live-photo-contain",
    parentElement: slide,
    style: { display: "block", visibility: "visible", opacity: "1" },
    elements: [image],
    getAttribute() { return null; },
    getBoundingClientRect() { return { left: 250, top: 80, right: 850, bottom: 820, width: 600, height: 740 }; },
    querySelectorAll() { return this.elements; },
    closest() { return this; }
  };
  image.parentElement = host;
  return { host, slide, image };
}

test("preloaded Live hosts bind every slide and follow the active host through 1→5", () => {
  const fixtures = Array.from({ length: 5 }, (_, index) => liveHost(index + 1));
  const records = Array.from({ length: 5 }, (_, index) => ({
    id: `live-${index + 1}`,
    url: `https://sns-video.example.xhscdn.com/live-${index + 1}.mp4`,
    backupUrls: [],
    isLiveVideo: true,
    slideIndex: index + 1
  }));
  const context = {
    result: null,
    pageState: { value: 1 },
    liveHostSelector: ".live-photo-contain",
    liveRecordByHost: new WeakMap(),
    note: { images: Array.from({ length: 5 }, (_, index) => ({ url: `https://sns-img.example.xhscdn.com/live-cover-${index + 1}.webp` })) },
    media: new Map(records.map(record => [record.id, record])),
    document: { querySelectorAll() { return fixtures.map(item => item.host); } },
    currentSlideIndex() { return context.pageState.value; },
    mediaSemantics(element) { return `${element.className || ""} ${element.parentElement?.className || ""}`; },
    candidateScore(element) { return element.score; },
    urlKey(value) { return new URL(value).pathname; },
    getComputedStyle(element) { return element.style || { display: "block", visibility: "visible", opacity: "1" }; },
    innerWidth: 1200,
    innerHeight: 900,
    Array, Number, String, WeakMap, URL, Map
  };
  vm.runInNewContext(liveFunctionSource, context);

  for (let page = 1; page <= 5; page++) {
    context.pageState.value = page;
    fixtures.forEach((item, index) => { item.slide.className = index + 1 === page ? "swiper-slide swiper-slide-active" : "swiper-slide"; });
    vm.runInNewContext("result = activeLiveSelection();", context);
    assert.equal(context.result.record.slideIndex, page);
    assert.equal(context.result.element.currentSrc, `https://sns-img.example.xhscdn.com/live-cover-${page}.webp`);
  }
});

test("a prebound Live host keeps its slide record when the cover img becomes a blob video", () => {
  const fixture = liveHost(2);
  fixture.slide.className = "swiper-slide swiper-slide-active";
  const record = { id: "live-2", url: "https://sns-video.example.xhscdn.com/live-2.mp4", backupUrls: [], isLiveVideo: true, slideIndex: 2 };
  const context = {
    result: null,
    pageState: { value: 2 },
    liveHostSelector: ".live-photo-contain",
    liveRecordByHost: new WeakMap(),
    note: { images: [{ url: "https://sns-img.example.xhscdn.com/live-cover-1.webp" }, { url: fixture.image.currentSrc }] },
    media: new Map([[record.id, record]]),
    document: { querySelectorAll() { return [fixture.host]; } },
    currentSlideIndex() { return context.pageState.value; },
    mediaSemantics(element) { return `${element.className || ""} ${element.parentElement?.className || ""}`; },
    candidateScore(element) { return element.score; },
    urlKey(value) { return /^blob:/i.test(value) ? value : new URL(value).pathname; },
    getComputedStyle(element) { return element.style || { display: "block", visibility: "visible", opacity: "1" }; },
    innerWidth: 1200,
    innerHeight: 900,
    Array, Number, String, WeakMap, URL, Map
  };
  vm.runInNewContext(`${liveFunctionSource}\nprebindLiveHosts();`, context);
  const video = liveNode("VIDEO", "blob:https://www.xiaohongshu.com/live-2");
  video.parentElement = fixture.host;
  video.score = 200;
  fixture.host.elements = [video];
  vm.runInNewContext("result = activeLiveSelection();", context);
  assert.equal(context.result.record.slideIndex, 2);
  assert.equal(context.result.element.tagName, "VIDEO");
});

test("Live badge uses the normal pointer cursor without hover scaling and a stable frame survives temporary node changes", () => {
  assert.match(overlayStyle, /\.xhs-dl-fixed-badge\.is-live:hover\s*\{[\s\S]*?transform:\s*none;[\s\S]*?pointer-events:\s*auto;[\s\S]*?cursor:\s*pointer/);
  assert.match(source, /document\.addEventListener\("pointerdown", captureLiveBadgePointer, true\)/);
  assert.match(source, /document\.addEventListener\("click", captureLiveBadgePointer, true\)/);
  assert.match(source, /activeXhsLiveFrame && activeXhsLiveFrame\.id === activeXhsRecord\.id[\s\S]*?syncActiveBadge\(\)/);
  assert.match(source, /retainCurrentLiveFrame[\s\S]*?activeXhsMotionStable = true;[\s\S]*?syncActiveBadge\(\)/);
  assert.doesNotMatch(source, /liveBadgeHovered/);
  assert.doesNotMatch(overlayStyle, /\.huaban-dl-badge:hover\s*\{[^}]*transform:\s*none/,
    "ordinary image and video badges must keep their existing hover behavior");
});

test("Live fixed visuals hide during page scrolling and are rebound only after scrolling stops", () => {
  assert.match(source, /function handleLiveScroll\(\)[\s\S]*?livePageScrolling = true;[\s\S]*?hideLiveVisualsDuringScroll\(\)/);
  assert.match(source, /liveScrollTimer = setTimeout\(function\(\) \{[\s\S]*?activeXhsLiveFrame = null;[\s\S]*?activeXhsMotionStable = false;[\s\S]*?scheduleScan\(\)/);
  assert.match(source, /if \(livePageScrolling\) \{[\s\S]*?hideLiveVisualsDuringScroll\(\);[\s\S]*?requestAnimationFrame\(animationSync\)/);
  assert.match(source, /document\.addEventListener\("scroll", handleLiveScroll, true\)/);
});

test("Xiaohongshu outline keeps the 1.8.8 implementation without the 1.8.9 header clipping layer", () => {
  assert.doesNotMatch(source, /function fixedTopOcclusion\(\)/);
  assert.doesNotMatch(source, /fixedOutline\.style\.clipPath/);
});
