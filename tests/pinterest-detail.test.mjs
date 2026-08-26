import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("recognizes the main image and homepage-style recommendations on a Pinterest pin detail page", () => {
  const source = fs.readFileSync(new URL("../pinterest-content.js", import.meta.url), "utf8");
  const sent = [];
  let messageListener;
  let mutationCallback;
  let scheduledScan;
  let mainImageAvailable = false;

  const classList = { add() {}, toggle() {} };
  const card = {
    classList,
    children: [],
    querySelector() { return null; },
    appendChild(node) { this.children.push(node); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 700 }; },
  };
  const oversizedVisualContainer = {
    classList,
    children: [],
    querySelector() { return null; },
    appendChild(node) { this.children.push(node); },
  };
  const image = {
    tagName: "IMG",
    parentElement: card,
    width: 600,
    height: 900,
    naturalWidth: 1200,
    naturalHeight: 1800,
    currentSrc: "https://i.pinimg.com/736x/aa/bb/cc/example.jpg",
    src: "https://i.pinimg.com/736x/aa/bb/cc/example.jpg",
    alt: "Detail image",
    getBoundingClientRect() { return { left: 100, top: 50, width: 600, height: 600 }; },
    getAttribute(name) { return name === "srcset" ? "" : null; },
    closest(selector) {
      if (selector.includes('a[href*="/pin/"]') || selector.includes("data-test-image-signature")) return null;
      // 详情页的 visual 容器比主图大，包含留白和页面控件。
      if (selector.includes("closeup") || selector.includes("visual-content-container") || selector.includes("pin-image-container")) return oversizedVisualContainer;
      return null;
    },
  };
  const recommendationLink = {
    href: "https://www.pinterest.com/pin/999888777666555444/",
    classList,
    children: [],
    textContent: "",
    contains(node) { return node === recommendationImage; },
    closest(selector) {
      // Pin 详情页会把整个推荐瀑布流放在 Related 容器内。
      if (selector.includes("related") || selector.includes("Related")) return { ariaLabel: "Related Pins" };
      return null;
    },
    querySelector() { return null; },
    appendChild(node) { this.children.push(node); },
  };
  const recommendationImage = {
    width: 320,
    height: 480,
    naturalWidth: 640,
    naturalHeight: 960,
    currentSrc: "https://i.pinimg.com/736x/dd/ee/ff/recommendation.jpg",
    src: "https://i.pinimg.com/736x/dd/ee/ff/recommendation.jpg",
    alt: "Recommendation",
    getAttribute(name) { return name === "srcset" ? "" : null; },
    closest(selector) {
      if (selector.includes('a[href*="/pin/"]')) return recommendationLink;
      return null;
    },
  };
  const document = {
    documentElement: { classList },
    title: "Pinterest detail",
    addEventListener() {},
    querySelectorAll(selector) {
      if (!selector.includes("img")) return [];
      return mainImageAvailable ? [image, recommendationImage] : [recommendationImage];
    },
    querySelector(selector) {
      if (selector.includes("og:image:width")) return { content: "1200" };
      if (selector.includes("og:image:height")) return { content: "1800" };
      if (selector.includes("og:title")) return { content: "Detail image" };
      if (selector.includes("og:image") || selector.includes("twitter:image")) return { content: image.src };
      return null;
    },
    contains() { return true; },
    createElement() {
      return { className: "", classList, dataset: {}, style: {}, textContent: "", addEventListener() {} };
    },
  };
  const chrome = {
    storage: { local: { get(_keys, callback) { callback({ aesthetic_collector_enabled: true, aesthetic_selection_mode: "auto" }); } } },
    runtime: {
      lastError: null,
      sendMessage(message, callback) { sent.push(message); if (callback) callback({ added: 1, skipped: 0 }); },
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
  };
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
  }

  const context = vm.createContext({
    chrome,
    document,
    location: { pathname: "/pin/884183339823132641/", search: "", href: "https://www.pinterest.com/pin/884183339823132641/" },
    window: { addEventListener() {} },
    MutationObserver,
    URLSearchParams,
    Map,
    Set,
    setTimeout(callback) { scheduledScan = callback; return 1; },
    clearTimeout() {},
    console,
  });
  vm.runInContext(source, context);
  assert.equal(typeof messageListener, "function");

  // 首次扫描只有 meta 图片；Pinterest 异步挂载主图后应重新绑定可见容器。
  mainImageAvailable = true;
  mutationCallback();
  scheduledScan();
  assert.ok(card.children.some((node) => node.className === "huaban-dl-overlay"));
  assert.ok(card.children.some((node) => node.className === "huaban-dl-badge"));
  const detailOverlay = card.children.find((node) => node.className === "huaban-dl-overlay");
  const detailBadge = card.children.find((node) => node.className === "huaban-dl-badge");
  assert.equal(detailOverlay.style.left, "100px");
  assert.equal(detailOverlay.style.top, "50px");
  assert.equal(detailOverlay.style.width, "600px");
  assert.equal(detailOverlay.style.height, "600px");
  assert.equal(detailBadge.style.left, "668px");
  assert.equal(detailBadge.style.top, "618px");
  assert.equal(oversizedVisualContainer.children.length, 0);
  assert.ok(recommendationLink.children.some((node) => node.className === "huaban-dl-overlay"));
  assert.ok(recommendationLink.children.some((node) => node.className === "huaban-dl-badge"));

  let response;
  messageListener({ action: "COLLECT" }, {}, (value) => { response = value; });
  assert.equal(response.started, true);
  const addMessage = sent.find((message) => message.action === "ADD_IMAGES");
  assert.ok(addMessage);
  assert.equal(addMessage.pins.length, 2);
  assert.deepEqual(Array.from(addMessage.pins, (pin) => pin.pin_id).sort(), [
    "pinterest:884183339823132641",
    "pinterest:999888777666555444",
  ]);
  assert.equal(addMessage.pins.find((pin) => pin.pin_id === "pinterest:884183339823132641").url,
    "https://i.pinimg.com/originals/aa/bb/cc/example.jpg");
  assert.equal(addMessage.pins.find((pin) => pin.pin_id === "pinterest:999888777666555444").url,
    "https://i.pinimg.com/originals/dd/ee/ff/recommendation.jpg");
});
