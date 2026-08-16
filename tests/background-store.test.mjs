import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "background.js"), "utf8");

function createRuntime() {
  const data = {};
  let listener;
  const storage = {
    get(keys, callback) {
      const result = {};
      for (const key of keys) if (key in data) result[key] = data[key];
      callback(result);
    },
    set(values, callback) {
      Object.assign(data, structuredClone(values));
      if (callback) callback();
    },
    remove(keys, callback) {
      for (const key of keys) delete data[key];
      if (callback) callback();
    }
  };
  const chrome = {
    downloads: { download(_options, callback) { if (callback) callback(1); } },
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage() {}
    },
    storage: { local: storage },
    tabs: { sendMessage() {} }
  };
  vm.runInNewContext(source, { chrome, console, Promise, setTimeout }, { filename: "background.js" });

  return {
    data,
    dispatch(message) {
      return new Promise((resolve, reject) => {
        try { listener(message, {}, resolve); }
        catch (error) { reject(error); }
      });
    }
  };
}

test("deduplicates pending pins and persists board statistics", async () => {
  const runtime = createRuntime();
  const boardInfo = { boardId: 7, boardTitle: "Synthetic board", creator: "Fixture" };
  const pins = [
    { pin_id: 101, url: "https://example.test/1.jpg", fileKey: "1", fileType: "jpg", width: 800, height: 600 },
    { pin_id: 102, url: "https://example.test/2.jpg", fileKey: "2", fileType: "jpg", width: 800, height: 600 },
    { pin_id: 101, url: "https://example.test/1.jpg", fileKey: "1", fileType: "jpg", width: 800, height: 600 }
  ];

  const added = await runtime.dispatch({ action: "ADD_IMAGES", boardInfo, pins });
  assert.equal(added.added, 2);
  assert.equal(added.skipped, 1);
  assert.equal(added.total, 2);

  const stats = await runtime.dispatch({ action: "GET_STATS" });
  assert.equal(stats.imageCount, 2);
  assert.equal(stats.boardCount, 1);
  assert.equal(stats.boards[0].pinCount, 2);

  const repeated = await runtime.dispatch({ action: "ADD_IMAGES", boardInfo, pins: pins.slice(0, 1) });
  assert.equal(repeated.added, 0);
  assert.equal(repeated.skipped, 1);
  assert.equal(repeated.total, 2);
  assert.equal(Object.keys(runtime.data.huaban_images).length, 2);
});

test("removes filtered pins from an existing pending queue", async () => {
  const runtime = createRuntime();
  const boardInfo = { boardId: 9, boardTitle: "Filter fixture", creator: "Fixture" };
  const pins = [
    { pin_id: 201, url: "https://example.test/a.jpg", width: 800, height: 600 },
    { pin_id: 202, url: "https://example.test/b.jpg", width: 800, height: 600 }
  ];
  await runtime.dispatch({ action: "ADD_IMAGES", boardInfo, pins });
  const removed = await runtime.dispatch({ action: "REMOVE_FILTERED_IMAGES", pinIds: [201] });
  assert.equal(removed.removed, 1);
  assert.equal(removed.total, 1);
  assert.deepEqual(Array.from(removed.removedPinIds), ["201"]);
  assert.equal(Object.keys(runtime.data.huaban_images).length, 1);
});

test("returns the task to idle when manual exclusions empty the pending queue", async () => {
  const runtime = createRuntime();
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "pinterest-page", boardTitle: "Pinterest" },
    pins: [{ pin_id: "pinterest:501", url: "https://i.pinimg.com/originals/501.jpg" }]
  });
  const result = await runtime.dispatch({ action: "REMOVE_FILTERED_IMAGES", pinIds: ["pinterest:501"] });
  assert.equal(result.removed, 1);
  assert.equal(result.total, 0);
  assert.equal(runtime.data.huaban_task.status, "idle");
});

test("removes every pending image from a deselected Zcool work", async () => {
  const runtime = createRuntime();
  const zcoolBoard = { boardId: "zcool_Test work", boardTitle: "站酷: Test work", creator: "站酷" };
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: zcoolBoard,
    pins: [
      { pin_id: "zcool:work:1", url: "https://img.zcool.cn/1.jpg" },
      { pin_id: "zcool:work:2", url: "https://img.zcool.cn/2.jpg" }
    ]
  });
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "huaban-other", boardTitle: "Huaban" },
    pins: [{ pin_id: 999, url: "https://gd-hbimg-edge.huaban.com/other.jpg" }]
  });

  const result = await runtime.dispatch({ action: "REMOVE_BOARD_IMAGES", boardId: zcoolBoard.boardId });
  assert.equal(result.removed, 2);
  assert.equal(result.total, 1);
  assert.deepEqual(Object.keys(runtime.data.huaban_images), ["999"]);
  assert.equal(runtime.data.huaban_boards[zcoolBoard.boardId], undefined);
});

test("aggregates a mixed Huaban, Pinterest, Zcool and Xiaohongshu queue without breaking stats", async () => {
  const runtime = createRuntime();
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "huaban-search", boardTitle: "Huaban", sourceUrl: "https://huaban.com/search?q=ip" },
    pins: [{ pin_id: 301, url: "https://gd-hbimg-edge.huaban.com/a.jpg" }]
  });
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "pinterest-search", boardTitle: "Pinterest", sourceUrl: "https://www.pinterest.com/search/pins/?q=ip" },
    pins: [{ pin_id: "pinterest:302", url: "https://i.pinimg.com/originals/b.jpg" }]
  });
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "zcool-search", boardTitle: "Zcool", sourceUrl: "https://www.zcool.com.cn/search/content?word=IP" },
    pins: [{ pin_id: "zcool:work:image", url: "https://img.zcool.cn/community/c.gif" }]
  });
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "xiaohongshu-note", boardTitle: "小红书: Note", sourceUrl: "https://www.xiaohongshu.com/explore/test" },
    pins: [{ pin_id: "xiaohongshu:note:image:1", url: "https://sns-img.example.xhscdn.com/note.jpg" }]
  });

  const stats = await runtime.dispatch({ action: "GET_STATS" });
  assert.equal(stats.imageCount, 4);
  assert.deepEqual(Array.from(stats.boards, item => item.title).sort(), ["Pinterest", "小红书", "站酷", "花瓣"]);
  assert.equal(stats.boards.reduce((sum, item) => sum + item.pinCount, 0), 4);
});

test("acknowledges download completion and retains only failed queue items", async () => {
  const runtime = createRuntime();
  await runtime.dispatch({
    action: "ADD_IMAGES",
    boardInfo: { boardId: "mixed", boardTitle: "Mixed" },
    pins: [
      { pin_id: 401, url: "https://gd-hbimg-edge.huaban.com/a.jpg" },
      { pin_id: "pinterest:402", url: "https://i.pinimg.com/originals/b.jpg" }
    ]
  });

  const response = await runtime.dispatch({ action: "DL_DONE", ok: 1, fail: 1, failedPinIds: ["pinterest:402"] });
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(runtime.data.huaban_images), ["pinterest:402"]);
  assert.equal(runtime.data.huaban_downloaded["401"], 1);
  assert.equal(runtime.data.huaban_task.status, "dl_done");
});
