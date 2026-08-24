// background.js - Huaban Downloader 后台服务
// 负责：持久化存储管理、去重、文件夹下载、任务状态管理
(function() {
  "use strict";

  // 点击扩展图标时直接打开 Chrome 右侧边栏。
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function() {});
  }

  if (chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener) chrome.runtime.onInstalled.addListener(function() {
    chrome.storage.local.get(["aesthetic_collector_enabled", "aesthetic_selection_mode"], function(data) {
      var defaults = {};
      if (typeof data.aesthetic_collector_enabled === "undefined") defaults.aesthetic_collector_enabled = true;
      if (typeof data.aesthetic_selection_mode === "undefined") defaults.aesthetic_selection_mode = "auto";
      if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
    });
  });

  // ── 存储操作 ───────────────────────────────────
  // huaban_images: 待下载的 pin 图片
  // huaban_downloaded: 已下载过的 pin_id（仅用于去重，不存详情）
  function getStore() {
    return new Promise(function(resolve) {
      chrome.storage.local.get(["huaban_images", "huaban_boards", "huaban_stats", "huaban_downloaded"], function(data) {
        resolve({
          images: data.huaban_images || {},
          boards: data.huaban_boards || {},
          stats: data.huaban_stats || { imageCount: 0, boardCount: 0, skippedDups: 0 },
          downloaded: data.huaban_downloaded || {}
        });
      });
    });
  }

  function saveStore(store) {
    return new Promise(function(resolve) {
      chrome.storage.local.set({
        huaban_images: store.images,
        huaban_boards: store.boards,
        huaban_stats: store.stats,
        huaban_downloaded: store.downloaded
      }, resolve);
    });
  }

  // ── 任务状态管理（持久化到 storage） ────────────
  // 状态：idle / collecting / downloading / done
  function getTaskState() {
    return new Promise(function(resolve) {
      chrome.storage.local.get(["huaban_task"], function(data) {
        resolve(data.huaban_task || { status: "idle" });
      });
    });
  }

  function setTaskState(state) {
    state.updatedAt = Date.now();
    return new Promise(function(resolve) {
      chrome.storage.local.set({ huaban_task: state }, resolve);
    });
  }

  // ── 添加图片（去重：同时检查待下载 + 已下载历史） ──
  // 花瓣的 pin_id 全局唯一，直接用 pin_id 作为 key
  async function addImages(boardInfo, pins) {
    var store = await getStore();
    var added = 0;
    var skipped = 0;

    pins.forEach(function(pin) {
      var key = String(pin.pin_id);
      if (store.images[key] || store.downloaded[key]) {
        skipped++;
        return;
      }
      store.images[key] = {
        url: pin.url,
        pin_id: pin.pin_id,
        fileKey: pin.fileKey,
        fileType: pin.fileType,
        mediaType: pin.mediaType || "image",
        backupUrls: Array.isArray(pin.backupUrls) ? pin.backupUrls : [],
        convertToGif: pin.convertToGif === true,
        isLiveVideo: pin.isLiveVideo === true,
        isVimeo: pin.isVimeo === true,
        width: pin.width,
        height: pin.height,
        text: pin.text || "",
        exportName: pin.exportName || pin.text || "",
        boardId: boardInfo.boardId,
        boardTitle: boardInfo.boardTitle,
        creator: boardInfo.creator,
        sourceUrl: boardInfo.sourceUrl || "",
        addedAt: Date.now()
      };
      added++;
    });

    if (added > 0 && boardInfo.boardId) {
      var bid = String(boardInfo.boardId);
      if (!store.boards[bid]) {
        store.boards[bid] = {
          title: boardInfo.boardTitle,
          creator: boardInfo.creator,
          sourceUrl: boardInfo.sourceUrl || "",
          pinCount: 0,
          addedAt: Date.now()
        };
      }
      store.boards[bid].addedAt = Date.now();
      store.boards[bid].sourceUrl = boardInfo.sourceUrl || store.boards[bid].sourceUrl || "";
      // 更新该画板的 pin 计数
      var count = 0;
      Object.keys(store.images).forEach(function(k) {
        if (String(store.images[k].boardId) === bid) count++;
      });
      store.boards[bid].pinCount = count;
    }

    store.stats.imageCount = Object.keys(store.images).length;
    store.stats.boardCount = Object.keys(store.boards).length;
    store.stats.skippedDups += skipped;

    await saveStore(store);
    return { added: added, skipped: skipped, total: store.stats.imageCount };
  }

  function extractAssignedJson(source, marker) {
    var markerAt = String(source || "").indexOf(marker);
    if (markerAt < 0) return null;
    var start = source.indexOf("{", markerAt + marker.length);
    if (start < 0) return null;
    var depth = 0, quote = "", escaped = false;
    for (var index = start; index < source.length; index++) {
      var char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); }
        catch (_error) { return null; }
      }
    }
    return null;
  }

  function vimeoProgressiveFiles(config) {
    var requestFiles = config && config.request && config.request.files;
    var progressive = requestFiles && Array.isArray(requestFiles.progressive) ? requestFiles.progressive : [];
    if (!progressive.length && config && config.video && Array.isArray(config.video.files)) progressive = config.video.files;
    return progressive.filter(function(file) {
      return file && /^https?:\/\//i.test(String(file.url || file.link || "")) &&
        (!file.mime || /video\/mp4/i.test(String(file.mime)));
    }).sort(function(a, b) {
      return (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0);
    });
  }

  function vimeoHlsUrls(config) {
    var hls = config && config.request && config.request.files && config.request.files.hls;
    if (!hls) return [];
    var values = [], cdns = hls.cdns || {};
    if (hls.default_cdn && cdns[hls.default_cdn]) values.push(cdns[hls.default_cdn].url || cdns[hls.default_cdn]);
    Object.keys(cdns).forEach(function(key) { values.push(cdns[key] && (cdns[key].url || cdns[key])); });
    if (hls.url) values.push(hls.url);
    var seen = new Set();
    return values.filter(function(value) {
      value = String(value || "");
      if (!/^https?:\/\//i.test(value) || seen.has(value)) return false;
      seen.add(value); return true;
    });
  }

  async function resolveVimeoPlayer(playerUrl) {
    var parsed;
    try { parsed = new URL(String(playerUrl || "")); } catch (_error) { return { ok: false, error: "Vimeo 地址无效" }; }
    if (parsed.hostname !== "player.vimeo.com" || !/^\/video\/\d+/i.test(parsed.pathname)) {
      return { ok: false, error: "Vimeo 播放器地址无效" };
    }
    try {
      var response = await fetch(parsed.href, { credentials: "omit", cache: "no-store",
        referrer: "https://www.behance.net/", referrerPolicy: "strict-origin-when-cross-origin" });
      if (!response.ok) return { ok: false, error: "Vimeo 解析失败：HTTP " + response.status };
      var html = await response.text();
      var config = extractAssignedJson(html, "window.playerConfig =") || extractAssignedJson(html, "window.playerConfig=");
      var files = vimeoProgressiveFiles(config), chosen = files[0];
      if (!chosen) {
        var hlsUrls = vimeoHlsUrls(config);
        if (hlsUrls.length) return { ok: true, url: hlsUrls[0], backupUrls: hlsUrls.slice(1),
          streamType: "hls", fileType: "video/mp4" };
        return { ok: false, error: "此 Vimeo 视频未开放可下载的 MP4 或 HLS 视频流" };
      }
      return { ok: true, url: chosen.url || chosen.link,
        backupUrls: files.slice(1).map(function(file) { return file.url || file.link; }),
        width: Number(chosen.width) || 0, height: Number(chosen.height) || 0,
        streamType: "progressive", fileType: "video/mp4" };
    } catch (error) {
      return { ok: false, error: "Vimeo 解析失败：" + (error && error.message || "网络错误") };
    }
  }

  // ── 下载完成：将待下载移入已下载历史，清空待下载 ──
  async function markDownloaded() {
    var store = await getStore();
    var keys = Object.keys(store.images);
    keys.forEach(function(key) {
      store.downloaded[key] = 1; // 只存 key，不存详情，省空间
    });
    store.images = {};
    store.boards = {};
    store.stats = { imageCount: 0, boardCount: 0, skippedDups: 0 };
    await saveStore(store);
    return { ok: true, movedCount: keys.length };
  }

  async function markDownloadResult(failedPinIds) {
    var store = await getStore();
    var failed = new Set((failedPinIds || []).map(String));
    Object.keys(store.images).forEach(function(key) {
      if (failed.has(key)) return;
      store.downloaded[key] = 1;
      delete store.images[key];
    });
    Object.keys(store.boards).forEach(function(id) {
      var remains = Object.keys(store.images).some(function(key) { return String(store.images[key].boardId) === id; });
      if (!remains) delete store.boards[id];
    });
    store.stats.imageCount = Object.keys(store.images).length;
    store.stats.boardCount = Object.keys(store.boards).length;
    await saveStore(store);
    return { remaining: store.stats.imageCount };
  }

  // ── 清空待下载（保留已下载历史，继续去重） ──────
  async function clearPending() {
    var store = await getStore();
    store.images = {};
    store.boards = {};
    store.stats = { imageCount: 0, boardCount: 0, skippedDups: 0 };
    await saveStore(store);
    await setTaskState({ status: "idle" });
    return { ok: true };
  }

  // ── 完全重置（清空一切，含已下载历史） ──────────
  async function clearAll() {
    await new Promise(function(resolve) {
      chrome.storage.local.remove([
        "huaban_images", "huaban_boards", "huaban_stats",
        "huaban_task", "huaban_downloaded", "huaban_filter_results", "huaban_filter_overrides"
      ], resolve);
    });
    return { ok: true };
  }

  async function removeFilteredImages(pinIds) {
    var store = await getStore();
    var removed = 0;
    var removedPinIds = [];
    (pinIds || []).forEach(function(pinId) {
      var key = String(pinId);
      if (store.images[key]) {
        delete store.images[key];
        removed++;
        removedPinIds.push(key);
      }
    });
    if (removed > 0) {
      Object.keys(store.boards).forEach(function(boardId) {
        var count = 0;
        Object.keys(store.images).forEach(function(key) {
          if (String(store.images[key].boardId) === boardId) count++;
        });
        if (count === 0) delete store.boards[boardId];
        else store.boards[boardId].pinCount = count;
      });
      store.stats.imageCount = Object.keys(store.images).length;
      store.stats.boardCount = Object.keys(store.boards).length;
      await saveStore(store);
      if (store.stats.imageCount === 0) await setTaskState({ status: "idle" });
    }
    return { ok: true, removed: removed, removedPinIds: removedPinIds, total: Object.keys(store.images).length };
  }

  // ── 撤回某个作品已经加入待下载的全部媒体 ────────
  async function removeBoardImages(boardId) {
    var store = await getStore();
    var targetId = String(boardId || "");
    var removed = 0;
    if (!targetId) return { ok: false, removed: 0, total: Object.keys(store.images).length };

    Object.keys(store.images).forEach(function(key) {
      if (String(store.images[key].boardId) !== targetId) return;
      delete store.images[key];
      removed++;
    });
    delete store.boards[targetId];
    store.stats.imageCount = Object.keys(store.images).length;
    store.stats.boardCount = Object.keys(store.boards).length;
    await saveStore(store);
    if (store.stats.imageCount === 0) await setTaskState({ status: "idle" });
    return { ok: true, removed: removed, total: store.stats.imageCount };
  }

  // ── 获取统计信息 ──────────────────────────────
  async function getStats() {
    var store = await getStore();
    var boardList = [];
    var sourceCounts = { "花瓣": 0, "Pinterest": 0, "站酷": 0, "小红书": 0, "Behance": 0 };
    var sourceUrls = { "花瓣": "", "Pinterest": "", "站酷": "", "小红书": "", "Behance": "" };
    var sourceAddedAt = { "花瓣": 0, "Pinterest": 0, "站酷": 0, "小红书": 0, "Behance": 0 };
    Object.keys(store.images).forEach(function(key) {
      var source = String(key).indexOf("pinterest:") === 0 ? "Pinterest" : String(key).indexOf("zcool:") === 0 ? "站酷" : String(key).indexOf("xiaohongshu:") === 0 ? "小红书" : String(key).indexOf("behance:") === 0 ? "Behance" : "花瓣";
      sourceCounts[source]++;
      var addedAt = store.images[key].addedAt || 0;
      if (addedAt >= sourceAddedAt[source]) {
        sourceAddedAt[source] = addedAt;
        if (store.images[key].sourceUrl) sourceUrls[source] = store.images[key].sourceUrl;
      }
    });
    Object.keys(sourceCounts).forEach(function(source) {
      if (sourceCounts[source] > 0) boardList.push({ boardId: "source_" + source, title: source, creator: "", pinCount: sourceCounts[source], sourceUrl: sourceUrls[source], addedAt: sourceAddedAt[source] });
    });
    /*Object.keys(store.boards).forEach(function(id) {
      var b = store.boards[id];
      var count = 0;
      Object.keys(store.images).forEach(function(key) {
        if (String(store.images[key].boardId) === id) count++;
      });
      boardList.push({
        boardId: id,
        title: b.title,
        creator: b.creator,
        pinCount: count
      });
    });*/
    boardList.sort(function(a, b) {
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    return {
      imageCount: store.stats.imageCount,
      boardCount: store.stats.boardCount,
      skippedDups: store.stats.skippedDups,
      downloadedCount: Object.keys(store.downloaded).length,
      boards: boardList
    };
  }

  // ── 文件夹下载（支持断点续传） ─────────────────
  async function downloadAll(tabId, resumeFrom) {
    var store = await getStore();
    var imageEntries = Object.values(store.images);

    if (imageEntries.length === 0) {
      chrome.runtime.sendMessage({ action: "DL_ERROR", message: "没有可下载的图片" });
      return;
    }

    // 记录正在下载的标签页
    chrome.storage.local.set({ huaban_dl_tabId: tabId });

    // 设置任务状态
    await setTaskState({
      status: "downloading",
      total: imageEntries.length,
      current: 0, ok: 0, fail: 0,
      resumeFrom: resumeFrom || 0
    });

    chrome.tabs.sendMessage(tabId, {
      action: "DO_DOWNLOAD",
      images: imageEntries,
      totalImages: imageEntries.length,
      collectionTitle: (function() {
        var latest = null;
        Object.keys(store.boards).forEach(function(id) {
          var board = store.boards[id];
          if (!latest || (board.addedAt || 0) > (latest.addedAt || 0)) latest = board;
        });
        return latest && latest.title ? latest.title.replace(/^(搜索|Pinterest|小红书):\s*/, "") : "采集素材";
      })(),
      resumeFrom: resumeFrom || 0
    });
  }

  // ── 消息监听 ──────────────────────────────────
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

    if (msg.action === "ADD_IMAGES") {
      addImages(msg.boardInfo, msg.pins).then(function(result) {
        sendResponse(result);
      });
      return true;
    }

    if (msg.action === "RESOLVE_VIMEO") {
      resolveVimeoPlayer(msg.playerUrl).then(sendResponse);
      return true;
    }

    if (msg.action === "GET_STATS") {
      getStats().then(function(stats) {
        sendResponse(stats);
      });
      return true;
    }

    if (msg.action === "GET_DOWNLOAD_DATA") {
      getStore().then(function(store) {
        var latest = null;
        Object.keys(store.boards).forEach(function(id) {
          var board = store.boards[id];
          if (!latest || (board.addedAt || 0) > (latest.addedAt || 0)) latest = board;
        });
        sendResponse({ images: Object.values(store.images), title: latest && latest.title || "Pinterest" });
      });
      return true;
    }

    if (msg.action === "GET_TASK_STATE") {
      getTaskState().then(function(state) {
        sendResponse(state);
      });
      return true;
    }

    if (msg.action === "CLEAR_ALL") {
      clearAll().then(function(result) {
        sendResponse(result);
      });
      return true;
    }

    if (msg.action === "CLEAR_PENDING") {
      clearPending().then(function(result) {
        sendResponse(result);
      });
      return true;
    }

    if (msg.action === "REMOVE_FILTERED_IMAGES") {
      removeFilteredImages(msg.pinIds).then(function(result) { sendResponse(result); });
      return true;
    }

    if (msg.action === "REMOVE_BOARD_IMAGES") {
      removeBoardImages(msg.boardId).then(function(result) { sendResponse(result); });
      return true;
    }

    if (msg.action === "DOWNLOAD_ALL") {
      downloadAll(msg.tabId);
      sendResponse({ started: true });
      return;
    }

    if (msg.action === "RESUME_DOWNLOAD") {
      downloadAll(msg.tabId, msg.resumeFrom);
      sendResponse({ started: true });
      return;
    }

    // ── 任务状态更新（content.js 上报进度） ──────
    if (msg.action === "COLLECT_START") {
      setTaskState({ status: "collecting", total: msg.total, current: 0 });
      return;
    }

    if (msg.action === "COLLECT_PROGRESS") {
      setTaskState({
        status: "collecting",
        total: msg.total,
        current: msg.current,
        ok: msg.ok
      });
      return;
    }

    if (msg.action === "COLLECT_DONE") {
      setTaskState({
        status: "collect_done",
        ok: msg.ok,
        fail: msg.fail,
        added: msg.added,
        skipped: msg.skipped
      });
      return;
    }

    if (msg.action === "DL_PROGRESS") {
      setTaskState({
        status: "downloading",
        total: msg.total,
        current: msg.current,
        ok: msg.ok,
        fail: msg.fail
      });
      return;
    }

    if (msg.action === "DL_ZIPPING") {
      setTaskState({ status: "zipping", percent: msg.percent || 0 });
      return;
    }

    if (msg.action === "DL_DONE") {
      chrome.storage.local.remove("huaban_dl_tabId");
      // 自动将已下载的图片移入历史（用于后续去重），清空待下载列表
      markDownloadResult(msg.failedPinIds).then(function(result) {
        return setTaskState({
          status: "dl_done",
          ok: msg.ok,
          fail: msg.fail,
          visualDuplicates: msg.visualDuplicates || 0,
          filename: msg.filename,
          remaining: result.remaining,
          failureReasons: msg.failureReasons || {}
        });
      }).then(function() {
        sendResponse({ ok: true });
      }).catch(function(error) {
        sendResponse({ ok: false, error: error && error.message || "保存下载结果失败" });
      });
      return true;
    }

    if (msg.action === "DL_ERROR") {
      setTaskState({ status: "idle" });
      return;
    }

    if (msg.action === "ERROR") {
      setTaskState({ status: "idle" });
      return;
    }

    // ── 强制重置任务状态 ──────────────────────────
    if (msg.action === "FORCE_RESET") {
      chrome.storage.local.remove("huaban_dl_tabId");
      setTaskState({ status: "idle" }).then(function() {
        sendResponse({ ok: true });
      });
      return true;
    }

    // ── 任务被用户中止（保存断点，支持续传） ──────
    if (msg.action === "ABORTED") {
      chrome.storage.local.remove("huaban_dl_tabId");
      if (msg.phase === "download" && msg.completedBatches !== undefined) {
        setTaskState({
          status: "paused",
          phase: "download",
          completedBatches: msg.completedBatches,
          totalBatches: msg.totalBatches,
          total: msg.total,
          processed: msg.processed,
          ok: msg.ok
        });
      } else {
        setTaskState({ status: "idle" });
      }
      return;
    }

    // ── 单批完成（更新断点） ───────────────────────
    if (msg.action === "BATCH_COMPLETE") {
      setTaskState({
        status: "downloading",
        completedBatches: msg.completedBatches,
        totalBatches: msg.totalBatches
      });
      return;
    }

    // 使用 chrome.downloads 将文件保存到指定的下载子目录
    if (msg.action === "TRIGGER_DOWNLOAD") {
      chrome.downloads.download({
        url: msg.blobUrl || msg.dataUrl,
        filename: msg.filename,
        saveAs: msg.saveAs === true
      }, function(downloadId) {
        if (chrome.runtime.lastError) {
          console.warn("[HUABAN BG] download failed:", chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId: downloadId });
        }
      });
      return true; // 异步 sendResponse
    }
  });

})();
