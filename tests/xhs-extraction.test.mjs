import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "xhs-inject.js"), "utf8");

test("keeps only the real video stream for a Xiaohongshu video note", () => {
  let payload = "";
  const document = {
    title: "Fixture note - 小红书",
    documentElement: {
      setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; }
    },
    dispatchEvent() {}
  };
  const context = {
    document,
    location: { pathname: "/explore/fixture123" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL,
    Set,
    setInterval() {},
    setTimeout(fn) { fn(); },
    addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = {
    note: {
      noteDetailMap: {
        fixture123: {
          note: {
            noteId: "fixture123",
            title: "完整图集",
            user: { nickname: "作者" },
            imageList: [
              { width: 1200, height: 1600, urlDefault: "https://sns-img.example.xhscdn.com/1.jpg?imageView2/2/w/1080/format/webp" },
              { width: 1600, height: 900, infoList: [{ imageScene: "WB_DFT", url: "https://sns-img.example.xhscdn.com/2.jpg?imageView2/2/w/1440/format/webp" }] },
              { width: 1080, height: 1440, urlDefault: "https://sns-img.example.xhscdn.com/3.jpg",
                livePhotoInfo: { stream: { masterUrl: "https://sns-video.example.xhscdn.com/live.mp4" } } }
            ],
            video: { media: { stream: { h264: [
              { masterUrl: "https://sns-video.example.xhscdn.com/main.mp4", backupUrl: "https://sns-video.example.xhscdn.com/backup.mp4" }
            ] } } }
          }
        }
      }
    }
  };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.noteId, "fixture123");
  assert.equal(parsed.isVideo, true);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.images)), [
    { url: "https://sns-img.example.xhscdn.com/1.jpg", width: 1200, height: 1600 },
    { url: "https://sns-img.example.xhscdn.com/2.jpg", width: 1600, height: 900 },
    { url: "https://sns-img.example.xhscdn.com/3.jpg", width: 1080, height: 1440, live: true }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.videos)), [
    { url: "https://sns-video.example.xhscdn.com/main.mp4", backupUrls: ["https://sns-video.example.xhscdn.com/backup.mp4"], live: false, slideIndex: 0 }
  ]);
});

test("extracts a Motion Photo video and marks its static cover as Live", () => {
  let payload = "";
  const document = {
    title: "Live fixture - 小红书",
    documentElement: { setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; } },
    dispatchEvent() {}
  };
  const context = {
    document,
    location: { pathname: "/explore/live456" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL, Set,
    setInterval() {}, setTimeout(fn) { fn(); }, addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = { note: { noteDetailMap: { live456: { note: {
    noteId: "live456", title: "Live 图文", imageList: [{
      width: 1080, height: 1440, urlDefault: "https://sns-img.example.xhscdn.com/live-cover.jpg",
      isLivePhoto: true,
      videoInfo: { media: { stream: { h264: [{
        backupUrl: "https://sns-video.example.xhscdn.com/live-backup.mp4",
        masterUrl: "https://sns-video.example.xhscdn.com/live-main.mp4"
      }] } } }
    }]
  } } } } };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.isVideo, false);
  assert.equal(parsed.images[0].live, true);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.videos)), [{
    url: "https://sns-video.example.xhscdn.com/live-main.mp4",
    backupUrls: ["https://sns-video.example.xhscdn.com/live-backup.mp4"],
    live: true,
    slideIndex: 1
  }]);
});

test("builds an MP4 URL from the legacy originVideoKey schema", () => {
  let payload = "";
  const document = {
    title: "Legacy video - 小红书",
    documentElement: { setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; } },
    dispatchEvent() {}, querySelector() { return null; }
  };
  const context = {
    document,
    location: { pathname: "/explore/legacy789" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL, Set,
    setInterval() {}, setTimeout(fn) { fn(); }, addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = { note: { noteDetailMap: { legacy789: { note: {
    noteId: "legacy789", type: "video", imageList: [{ urlDefault: "https://sns-img.example.xhscdn.com/poster.jpg" }],
    video: { consumer: { originVideoKey: "stream/legacy-real-video.mp4" } }
  } } } } };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.isVideo, true);
  assert.equal(parsed.videos[0].url, "https://sns-video-bd.xhscdn.com/stream/legacy-real-video.mp4");
});

test("falls back to masterUrl values in fresh note HTML and prefers _114.mp4", async () => {
  let payload = "";
  const document = {
    title: "HTML fallback - 小红书",
    documentElement: { setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; } },
    dispatchEvent() {}, querySelector() { return null; }, querySelectorAll() { return []; }
  };
  const context = {
    document,
    location: { pathname: "/explore/html999", href: "https://www.xiaohongshu.com/explore/html999" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL, Set, Array,
    fetch: async () => ({ ok: true, text: async () => '<script>{"masterUrl":"https://sns-video.example.xhscdn.com/stream/demo_84.mp4","masterUrl":"https://sns-video.example.xhscdn.com/stream/demo_114.mp4"}</script>' }),
    setInterval() {}, setTimeout(fn) { fn(); }, addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = { note: { noteDetailMap: { html999: { note: {
    noteId: "html999", type: "video", imageList: [{ urlDefault: "https://sns-img.example.xhscdn.com/poster.jpg" }]
  } } } } };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  await new Promise(resolve => setTimeout(resolve, 0));
  const parsed = JSON.parse(payload);
  assert.equal(parsed.isVideo, true);
  assert.equal(parsed.videos[0].url, "https://sns-video.example.xhscdn.com/stream/demo_114.mp4");
});

test("binds a newly visible Live stream to each carousel slide without reopening the note", () => {
  let payload = "", slide = 1, publishInterval = null;
  const counter = { childElementCount: 0, get textContent() { return `${slide}/2`; },
    getBoundingClientRect() { return { width: 40, height: 20 }; } };
  const liveMarker = { className: "live-photo-contain", textContent: "LIVE", getAttribute() { return "live-photo-contain"; },
    getBoundingClientRect() { return { width: 800, height: 600 }; } };
  const video = { get currentSrc() { return `https://sns-video.example.xhscdn.com/live-${slide}.mp4`; },
    src: "", getAttribute() { return ""; }, querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600 }; } };
  const document = {
    title: "Multi Live - 小红书",
    documentElement: { setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; } },
    dispatchEvent() {}, querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === "video") return [video];
      if (selector === "video, video source") return [video];
      if (selector.startsWith('.live-photo-contain')) return [liveMarker];
      return [counter];
    }
  };
  const context = {
    document, location: { pathname: "/explore/multilive" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL, Set, Array, innerWidth: 1200, innerHeight: 800,
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    setInterval(fn) { publishInterval = fn; }, setTimeout(fn) { fn(); }, addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = { note: { noteDetailMap: { multilive: { note: {
    noteId: "multilive", title: "两张 Live", imageList: [
      { width: 1080, height: 1440, urlDefault: "https://sns-img.example.xhscdn.com/cover-1.jpg" },
      { width: 1080, height: 1440, urlDefault: "https://sns-img.example.xhscdn.com/cover-2.jpg" }
    ]
  } } } } };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  let parsed = JSON.parse(payload);
  assert.equal(parsed.images[0].live, true, "the first Live cover must not enter the image queue");
  assert.equal(parsed.images[1].live, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.videos.map(item => item.slideIndex))), [1]);
  slide = 2;
  publishInterval();
  parsed = JSON.parse(payload);
  assert.equal(parsed.images[0].live, true);
  assert.equal(parsed.images[1].live, true, "the second Live cover must not enter the image queue");
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.videos.map(item => item.slideIndex))), [1, 2]);
  assert.equal(parsed.videos[1].url, "https://sns-video.example.xhscdn.com/live-2.mp4");
});

test("recovers a real MP4 for a blob-backed Live slide and excludes its WebP cover", () => {
  let payload = "";
  const counter = { childElementCount: 0, textContent: "1/5",
    getBoundingClientRect() { return { width: 40, height: 20 }; } };
  const liveMarker = { className: "live-photo-contain", textContent: "LIVE", getAttribute() { return "live-photo-contain"; },
    getBoundingClientRect() { return { width: 800, height: 600 }; } };
  const video = { currentSrc: "blob:https://www.xiaohongshu.com/live-stream", src: "", getAttribute() { return ""; },
    querySelector() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600 }; } };
  const document = {
    title: "Blob Live - 小红书",
    documentElement: { setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; } },
    dispatchEvent() {}, querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === "video" || selector === "video, video source") return [video];
      if (selector.startsWith('.live-photo-contain')) return [liveMarker];
      return [counter];
    }
  };
  const context = {
    document, location: { pathname: "/explore/bloblive" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL, Set, Array, innerWidth: 1200, innerHeight: 800,
    performance: {
      now() { return 10000; },
      getEntriesByType(type) { return type === "resource" ? [{
        name: "https://sns-video.example.xhscdn.com/stream/blob-live_114.mp4", startTime: 9000
      }] : []; }
    },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    setInterval() {}, setTimeout(fn) { fn(); }, addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = { note: { noteDetailMap: { bloblive: { note: {
    noteId: "bloblive", title: "Blob Live", imageList: [{
      width: 1080, height: 1440, urlDefault: "https://sns-img.example.xhscdn.com/live-cover.webp"
    }]
  } } } } };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.images[0].live, true, "the WebP cover must be excluded from image export");
  assert.equal(parsed.videos.length, 1);
  assert.equal(parsed.videos[0].url, "https://sns-video.example.xhscdn.com/stream/blob-live_114.mp4");
  assert.equal(parsed.videos[0].live, true);
});

test("keeps five Live masterUrl streams as five slide MP4 records instead of one backup chain", async () => {
  let payload = "";
  const counter = { childElementCount: 0, textContent: "1/5",
    getBoundingClientRect() { return { width: 40, height: 20 }; } };
  const liveMarker = { className: "live-photo-contain", textContent: "LIVE", getAttribute() { return "live-photo-contain"; },
    getBoundingClientRect() { return { width: 800, height: 600 }; } };
  const document = {
    title: "Five Live - 小红书",
    documentElement: { setAttribute(name, value) { if (name === "data-aesthetic-xhs-note") payload = value; } },
    dispatchEvent() {}, querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === "video" || selector === "video, video source") return [];
      if (selector.startsWith('.live-photo-contain')) return [liveMarker];
      return [counter];
    }
  };
  const masterUrls = Array.from({ length: 5 }, (_, index) =>
    `"masterUrl":"https://sns-video.example.xhscdn.com/stream/live-${index + 1}_114.mp4"`).join(",");
  const context = {
    document, location: { pathname: "/explore/fivelive", href: "https://www.xiaohongshu.com/explore/fivelive" },
    history: { pushState() {}, replaceState() {} },
    Event: class Event { constructor(type) { this.type = type; } },
    URL, Set, Array, Object, innerWidth: 1200, innerHeight: 800,
    performance: { now() { return 1000; }, getEntriesByType() { return []; } },
    fetch: async () => ({ ok: true, text: async () => `<script>{${masterUrls}}</script>` }),
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    setInterval() {}, setTimeout(fn) { fn(); }, addEventListener() {}
  };
  context.window = context;
  context.__INITIAL_STATE__ = { note: { noteDetailMap: { fivelive: { note: {
    noteId: "fivelive", title: "五张 Live", imageList: Array.from({ length: 5 }, (_, index) => ({
      width: 1080, height: 1440, urlDefault: `https://sns-img.example.xhscdn.com/live-cover-${index + 1}.webp`
    }))
  } } } } };

  vm.runInNewContext(source, context, { filename: "xhs-inject.js" });
  await new Promise(resolve => setTimeout(resolve, 0));
  const parsed = JSON.parse(payload);
  assert.equal(parsed.videos.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.videos.map(item => item.slideIndex))), [1, 2, 3, 4, 5]);
  assert.equal(parsed.images.every(item => item.live === true), true, "no Live WebP cover may enter image export");
  assert.equal(parsed.videos.every(item => item.url.endsWith("_114.mp4")), true);
  assert.equal(parsed.videos.every(item => item.backupUrls.length === 0), true,
    "streams from different slides must not become one video's backup URLs");
});
