// content.js - Huaban Downloader 核心逻辑
// 运行在 ISOLATED world，注入到所有 huaban.com 页面
(function() {
  "use strict";

  var pluginEnabled = true;
  var selectionMode = "auto";
  function setPluginEnabled(enabled) {
    pluginEnabled = enabled !== false;
    document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
    if (!pluginEnabled) cleanup();
    else initPage();
  }

  // ── 工具函数 ────────────────────────────────────
  function sanitizeName(s) {
    if (!s) return "untitled";
    var result = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95) {
        result += s[i];
      } else if (c === 32) {
        result += "_";
      }
    }
    return result.slice(0, 60) || "untitled";
  }

  function getTimestampStr(date) {
    var d = date || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1); while (m.length < 2) m = "0" + m;
    var day = String(d.getDate()); while (day.length < 2) day = "0" + day;
    var h = String(d.getHours()); while (h.length < 2) h = "0" + h;
    var min = String(d.getMinutes()); while (min.length < 2) min = "0" + min;
    var sec = String(d.getSeconds()); while (sec.length < 2) sec = "0" + sec;
    return y + m + day + "_" + h + min + sec;
  }

  function getDateStr(date) {
    var d = date || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1); while (m.length < 2) m = "0" + m;
    var day = String(d.getDate()); while (day.length < 2) day = "0" + day;
    return y + m + day;
  }

  function getExtFromType(mimeType) {
    if (!mimeType) return ".jpg";
    if (mimeType.indexOf("png") !== -1) return ".png";
    if (mimeType.indexOf("gif") !== -1) return ".gif";
    if (mimeType.indexOf("webp") !== -1) return ".webp";
    return ".jpg";
  }

  function getExtFromUrl(url) {
    if (!url) return ".jpg";
    var clean = url.split("?")[0].toLowerCase();
    if (clean.indexOf(".png") !== -1) return ".png";
    if (clean.indexOf(".gif") !== -1) return ".gif";
    if (clean.indexOf(".webp") !== -1) return ".webp";
    return ".jpg";
  }

  function getOriginalImageName(img) {
    var source = String(img.url || img.fileKey || img.pin_id || "image").split("?")[0].split("#")[0];
    var name = source.substring(source.lastIndexOf("/") + 1);
    try { name = decodeURIComponent(name); } catch (_error) { /* 保留原值 */ }
    name = name.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
    return sanitizeName(name || img.pin_id || "image");
  }

  // 安全发消息（popup 可能已关闭）
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, function() {
        if (chrome.runtime.lastError) { /* popup closed, ignore */ }
      });
    } catch(e) { /* extension context invalidated */ }
  }

  // ── IP 素材预过滤 ──────────────────────────────
  var filterSettings = HuabanFilter.mergeSettings();
  var filterResults = new Map();       // pin_id -> classification
  var knownPins = new Map();           // 本次页面已知的 pin 元数据，用于重新过滤
  var filterWork = new Map();          // pin_id -> Promise
  var hydrationWork = new Map();       // 仅有 pin_id 时补全图片元数据
  var directPinCards = new Map();      // 无 /pins/ 链接的详情页主图容器
  var autoExcludedPins = new Set();    // 仅记录智能过滤造成的取消，关闭时可恢复
  var manualAcceptedPins = new Set();  // 用户手动恢复的过滤图，优先于自动分类
  var manualDeselectedPins = new Set();// 用户主动取消，始终使用灰色状态
  var manualSelectedPins = new Set();  // 手动模式的已选项，跨模式切换保留
  var manualFilterOverridePins = new Set(); // 手动模式中明确恢复的过滤项
  var removedPendingPins = new Set();  // 曾从待下载撤回，重新勾选时恢复
  var lastSelectionMessage = "";
  var rejectedQueueTimer = null;

  function removePendingPins(pinIds) {
    var ids = (pinIds || []).map(String);
    if (ids.length === 0) return;
    chrome.runtime.sendMessage({ action: "REMOVE_FILTERED_IMAGES", pinIds: ids }, function(result) {
      if (chrome.runtime.lastError) return;
      if (result && result.removed > 0) {
        var removedIds = result.removedPinIds || ids;
        removedIds.forEach(function(id) { removedPendingPins.add(String(id)); });
        safeSend({ action: "PENDING_QUEUE_CHANGED", removed: result.removed });
        restorePendingPins(removedIds.filter(function(id) { return pinSelectionState.get(String(id)) === true; }));
      }
    });
  }

  function currentQueueBoardInfo() {
    var pt = detectPageType();
    if (pt === "board" && currentBoardData) return {
      boardId: currentBoardData.board_id, boardTitle: currentBoardData.title,
      creator: currentBoardData.description || "", sourceUrl: location.href
    };
    if (pt === "search") {
      var params = new URLSearchParams(location.search);
      var query = params.get("q") || params.get("word") || "搜索";
      return { boardId: "search_" + query, boardTitle: "搜索: " + query, creator: "", sourceUrl: location.href };
    }
    var pin = currentPinData || {};
    return { boardId: pin.boardId || 0, boardTitle: pin.boardTitle || "Pin 详情", creator: pin.creator || "", sourceUrl: location.href };
  }

  function restorePendingPins(pinIds) {
    var pins = [];
    (pinIds || []).forEach(function(rawId) {
      var pid = String(rawId);
      if (!removedPendingPins.has(pid)) return;
      var pin = knownPins.get(pid) || recommendedPinDataMap[pid] || (currentPinData && String(currentPinData.pin_id) === pid ? currentPinData : null);
      if (!pin || !pin.url) return;
      pins.push({ pin_id: pin.pin_id, url: pin.url, fileKey: pin.fileKey || "", fileType: pin.fileType || "",
        width: pin.width || 0, height: pin.height || 0, text: pin.text || "" });
    });
    if (!pins.length) return;
    chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: currentQueueBoardInfo(), pins: pins }, function(result) {
      if (chrome.runtime.lastError || !result) return;
      pins.forEach(function(pin) { removedPendingPins.delete(String(pin.pin_id)); });
      safeSend({ action: "PENDING_QUEUE_CHANGED", restored: result.added || 0 });
    });
  }

  function syncRejectedQueue() {
    clearTimeout(rejectedQueueTimer);
    rejectedQueueTimer = setTimeout(function() {
      var ids = [];
      filterResults.forEach(function(item, pid) {
        if (item.state !== "accepted" && !manualAcceptedPins.has(String(pid))) ids.push(pid);
      });
      removePendingPins(ids);
    }, 150);
  }

  chrome.storage.local.get(["huaban_filter_settings"], function(data) {
    filterSettings = HuabanFilter.mergeSettings(data.huaban_filter_settings);
    safeSend({ action: "FILTER_SETTINGS_READY", settings: filterSettings });
  });

  function normalizeImageUrl(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf("//") === 0) return "https:" + url;
    return "https://gd-hbimg-edge.huaban.com/" + String(url).replace(/^\//, "");
  }

  function findPinCard(pid) {
    var directCard = directPinCards.get(String(pid));
    if (directCard && document.contains(directCard)) return directCard;
    if (directCard) directPinCards.delete(String(pid));
    var link = document.querySelector('a[href*="/pins/' + pid + '"]');
    return findPinCardFromLink(link);
  }

  function enrichCopyrightFromCard(pin) {
    var card = pin && pin.pin_id ? findPinCard(String(pin.pin_id)) : null;
    var node = card;
    var depth = 0;
    while (node && depth < 8) {
      var pinLinks = node.querySelectorAll ? node.querySelectorAll('a[href*="/pins/"]') : [];
      if (pinLinks.length > 1) break;
      var signal = [node.textContent, node.getAttribute && node.getAttribute("title"),
        node.getAttribute && node.getAttribute("aria-label"), node.getAttribute && node.getAttribute("data-label"),
        node.getAttribute && node.getAttribute("data-type")].join(" ");
      if (/(版权\s*(?:素材|图片|作品)|PSD\s*(?:素材|源文件|下载)|(?:素材|源文件)\s*PSD|正版素材|付费素材|可商用素材)/i.test(signal)) {
        pin.isCopyright = true;
        pin.label = ((pin.label || "") + " " + signal).trim();
        break;
      }
      node = node.parentElement;
      depth++;
    }
    return pin;
  }

  function setCardFilterAppearance(pid) {
    var card = findPinCard(pid);
    var classification = filterResults.get(String(pid));
    if (!card || !classification) return;
    card.classList.remove("huaban-dl-filter-suspicious", "huaban-dl-filter-rejected");
    if (manualDeselectedPins.has(String(pid))) {
      card.classList.remove("huaban-dl-selected");
      card.classList.add("huaban-dl-deselected");
      var grayBadge = card.querySelector(".huaban-dl-badge");
      if (grayBadge) grayBadge.textContent = selectionMode === "manual" ? "" : "\u2717";
      var grayReason = card.querySelector(".huaban-dl-filter-reason");
      if (grayReason) grayReason.remove();
      pinSelectionState.set(String(pid), false);
      return;
    }
    if (manualAcceptedPins.has(String(pid))) {
      card.classList.remove("huaban-dl-deselected");
      card.classList.add("huaban-dl-selected");
      var manualBadge = card.querySelector(".huaban-dl-badge");
      if (manualBadge) manualBadge.textContent = "\u2713";
      var manualReason = card.querySelector(".huaban-dl-filter-reason");
      if (manualReason) manualReason.remove();
      pinSelectionState.set(String(pid), true);
      return;
    }
    if (classification.state === "suspicious") card.classList.add("huaban-dl-filter-suspicious");
    if (classification.state === "rejected") card.classList.add("huaban-dl-filter-rejected");
    if (classification.state !== "accepted") {
      autoExcludedPins.add(String(pid));
      card.classList.remove("huaban-dl-selected");
      card.classList.add("huaban-dl-deselected");
      var badge = card.querySelector(".huaban-dl-badge");
      if (badge) badge.textContent = "\u2717";
    }
    var reason = card.querySelector(".huaban-dl-filter-reason");
    if (!reason && classification.state !== "accepted") {
      reason = document.createElement("div");
      reason.className = "huaban-dl-filter-reason";
      card.appendChild(reason);
    }
    if (reason) {
      if (classification.state === "accepted") reason.remove();
      else reason.textContent = HuabanFilter.reasonLabel(classification.reason);
    }
  }

  function restoreAutoExcludedCard(pid) {
    var card = findPinCard(String(pid));
    if (!card) return;
    card.classList.remove("huaban-dl-filter-suspicious", "huaban-dl-filter-rejected", "huaban-dl-deselected");
    card.classList.add("huaban-dl-selected");
    var badge = card.querySelector(".huaban-dl-badge");
    if (badge) badge.textContent = "\u2713";
    var reason = card.querySelector(".huaban-dl-filter-reason");
    if (reason) reason.remove();
  }

  function pixelInfoFromBitmap(bitmap) {
    var size = 32;
    var canvas;
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(size, size);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
    }
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0, size, size);
    var data = ctx.getImageData(0, 0, size, size).data;
    var transparent = 0;
    var minX = size, minY = size, maxX = -1, maxY = -1;
    var gray = [];
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = (y * size + x) * 4;
        var alpha = data[i + 3];
        if (alpha < 230) transparent++;
        if (alpha >= 32) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        gray.push(Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114));
      }
    }
    var subjectRatio = maxX < 0 ? 0 : ((maxX - minX + 1) * (maxY - minY + 1)) / (size * size);
    var hash = "";
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        var yy = Math.floor(row * size / 8);
        var x1 = Math.floor(col * (size - 1) / 8);
        hash += gray[yy * size + x1] > gray[yy * size + x1 + 1] ? "1" : "0";
      }
    }
    return { alphaRatio: transparent / (size * size), subjectRatio: subjectRatio, hash: hash };
  }

  async function inspectPinPixels(pin) {
    var url = normalizeImageUrl(pin.url);
    if (!url) return HuabanFilter.result("accepted", null, 1);
    try {
      var response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var blob = await response.blob();
      var bitmap;
      if (typeof createImageBitmap === "function") {
        bitmap = await createImageBitmap(blob);
      } else {
        bitmap = await new Promise(function(resolve, reject) {
          var image = new Image();
          var objectUrl = URL.createObjectURL(blob);
          image.onload = function() { URL.revokeObjectURL(objectUrl); resolve(image); };
          image.onerror = function() { URL.revokeObjectURL(objectUrl); reject(new Error("image decode failed")); };
          image.src = objectUrl;
        });
      }
      var info = pixelInfoFromBitmap(bitmap);
      if (bitmap.close) bitmap.close();
      return HuabanFilter.classifyPixels(info, filterSettings);
    } catch (error) {
      return HuabanFilter.result("accepted", "decode_failed", 0.55, { error: error.message });
    }
  }

  function classifyPin(pin) {
    var pid = String(pin.pin_id);
    if (filterWork.has(pid)) return filterWork.get(pid);
    enrichCopyrightFromCard(pin);
    var metadata = HuabanFilter.classifyMetadata(pin, filterSettings);
    filterResults.set(pid, metadata);
    if (metadata.state !== "accepted") {
      pinSelectionState.set(pid, false);
      autoExcludedPins.add(pid);
    }
    if (metadata.state !== "accepted") syncRejectedQueue();
    setCardFilterAppearance(pid);
    // 版权素材仅依据元数据/页面标签判定，不请求原图。
    if (metadata.reason === "copyright_material") return Promise.resolve(metadata);
    var job = inspectPinPixels(pin).then(function(pixels) {
      var combined = filterSettings.enabled ? HuabanFilter.combine(metadata, pixels) : HuabanFilter.result("accepted", null, 1);
      filterResults.set(pid, combined);
      if (combined.state !== "accepted") {
        pinSelectionState.set(pid, false);
        autoExcludedPins.add(pid);
      }
      if (combined.state !== "accepted") syncRejectedQueue();
      setCardFilterAppearance(pid);
      updateSelectionCount();
      return combined;
    }).finally(function() { filterWork.delete(pid); });
    filterWork.set(pid, job);
    return job;
  }

  function applyMetadataClassification(pin) {
    var pid = String(pin.pin_id);
    enrichCopyrightFromCard(pin);
    knownPins.set(pid, pin);
    var metadata = HuabanFilter.classifyMetadata(pin, filterSettings);
    var existing = filterResults.get(pid);
    var combined = HuabanFilter.combine(metadata, existing);
    filterResults.set(pid, combined);
    if (combined.state !== "accepted") {
      pinSelectionState.set(pid, false);
      autoExcludedPins.add(pid);
    }
    if (combined.state !== "accepted") syncRejectedQueue();
    setCardFilterAppearance(pid);
  }

  function classifyPins(pins) {
    pins.forEach(function(pin) {
      knownPins.set(String(pin.pin_id), pin);
      applyMetadataClassification(pin);
      // 像素分析仅针对已进入可见瀑布流的卡片，避免采集时重复请求全部图片。
      if (findPinCard(String(pin.pin_id))) schedulePinClassification(pin);
    });
    safeSend({ action: "FILTER_DONE", stats: getFilterStats() });
    return Promise.all(Array.from(filterWork.values())).then(function() {
      safeSend({ action: "FILTER_DONE", stats: getFilterStats() });
      return pins;
    });
  }

  function schedulePinClassification(pin) {
    var pid = String(pin.pin_id);
    if (pin.url) {
      classifyPin(pin);
      return;
    }
    if (hydrationWork.has(pid) || filterResults.has(pid)) return;
    var job = fetchPinByApi(pid).then(function(fullPin) {
      recommendedPinDataMap[pid] = fullPin;
      return classifyPin(fullPin);
    }).catch(function() {
      return null;
    }).finally(function() { hydrationWork.delete(pid); });
    hydrationWork.set(pid, job);
  }

  function getFilterStats() {
    var stats = { accepted: 0, suspicious: 0, rejected: 0, manualExcluded: 0, reasons: {} };
    var ids = new Set();
    filterResults.forEach(function(_item, pid) { ids.add(String(pid)); });
    pinSelectionState.forEach(function(_value, pid) { ids.add(String(pid)); });
    ids.forEach(function(pid) {
      var item = filterResults.get(pid);
      if (manualDeselectedPins.has(pid)) { stats.manualExcluded++; return; }
      if (manualAcceptedPins.has(pid)) { stats.accepted++; return; }
      if (item && item.state !== "accepted") {
        stats[item.state] = (stats[item.state] || 0) + 1;
        if (item.reason) stats.reasons[item.reason] = (stats.reasons[item.reason] || 0) + 1;
        return;
      }
      if (pinSelectionState.get(pid) === false) stats.manualExcluded++;
      else stats.accepted++;
    });
    return stats;
  }

  function isPinCollectable(pin) {
    var pid = String(pin.pin_id);
    var classification = filterResults.get(pid);
    if (classification && classification.state !== "accepted" && !manualAcceptedPins.has(pid)) return false;
    return pinSelectionState.get(pid) !== false;
  }

  function refreshFilterState(enabled) {
    filterWork.clear();
    hydrationWork.clear();

    if (!enabled) {
      autoExcludedPins.forEach(function(pid) {
        filterResults.set(pid, HuabanFilter.result("accepted", null, 1));
        if ((selectionMode === "manual" && manualSelectedPins.has(String(pid))) ||
            (selectionMode !== "manual" && !manualDeselectedPins.has(String(pid)))) {
          pinSelectionState.set(pid, true);
          restoreAutoExcludedCard(pid);
        }
      });
      // 虚拟瀑布流可能已重建 DOM，再扫描一次所有当前可见的过滤卡片。
      document.querySelectorAll(".huaban-dl-filter-suspicious, .huaban-dl-filter-rejected").forEach(function(card) {
        var badge = card.querySelector(".huaban-dl-badge");
        var pid = badge && badge.dataset.pinId;
        if (pid) {
          filterResults.set(pid, HuabanFilter.result("accepted", null, 1));
          if ((selectionMode === "manual" && manualSelectedPins.has(String(pid))) ||
              (selectionMode !== "manual" && !manualDeselectedPins.has(String(pid)))) pinSelectionState.set(pid, true);
        }
        var choose = pid ? pinSelectionState.get(String(pid)) === true : false;
        card.classList.remove("huaban-dl-filter-suspicious", "huaban-dl-filter-rejected");
        card.classList.toggle("huaban-dl-selected", choose);
        card.classList.toggle("huaban-dl-deselected", !choose);
        if (badge) badge.textContent = choose ? "\u2713" : (selectionMode === "manual" ? "" : "\u2717");
        var reason = card.querySelector(".huaban-dl-filter-reason");
        if (reason) reason.remove();
      });
      autoExcludedPins.clear();
      updateSelectionCount();
      safeSend({ action: "FILTER_DONE", stats: getFilterStats() });
      return;
    }

    filterResults.clear();
    knownPins.forEach(function(pin) { schedulePinClassification(pin); });
    Object.keys(recommendedPinDataMap).forEach(function(pid) {
      var pin = recommendedPinDataMap[pid];
      if (pin && !knownPins.has(String(pid))) schedulePinClassification(pin);
    });
    updateSelectionCount();
  }

  // ── 任务中止控制 ───────────────────────────────
  var abortFlag = false;

  // ── 页面类型检测 ────────────────────────────────
  function detectPageType() {
    var path = location.pathname;
    if (/^\/boards\/\d+/.test(path)) return "board";
    if (/^\/search/.test(path)) return "search";
    if (/^\/pins\/\d+/.test(path)) return "pin";
    if (/^\/discovery/.test(path)) return "home";
    return "home";
  }

  // ── 通过 inject.js 读取 __NEXT_DATA__ ──────────
  function extractPageData() {
    return new Promise(function(resolve) {
      var resolved = false;

      function handler(event) {
        if (event.data && event.data.type === "__HUABAN_EXT_DATA__") {
          window.removeEventListener("message", handler);
          resolved = true;
          resolve(event.data.payload);
        }
      }
      window.addEventListener("message", handler);

      var script = document.createElement("script");
      script.src = chrome.runtime.getURL("inject.js");
      script.onload = function() { script.remove(); };
      script.onerror = function() {
        script.remove();
        if (!resolved) {
          window.removeEventListener("message", handler);
          resolved = true;
          resolve({ error: "inject.js load failed" });
        }
      };
      (document.head || document.documentElement).appendChild(script);

      setTimeout(function() {
        if (!resolved) {
          window.removeEventListener("message", handler);
          resolved = true;
          resolve({ error: "timeout" });
        }
      }, 5000);
    });
  }

  // ── 画板页 API 分页加载所有 Pin ────────────────
  // SSR 给前 40 个，后续通过 API 加载剩余
  function loadAllBoardPins(boardId, ssrPins) {
    return new Promise(function(resolve) {
      var allPins = ssrPins.slice(); // 复制 SSR 的前 40 个
      var lastPinId = allPins.length > 0 ? allPins[allPins.length - 1].pin_id : 0;

      function loadNext() {
        if (abortFlag) { resolve(allPins); return; }

        var url = "/v3/boards/" + boardId + "/pins?limit=40&sort=seq&max=" + lastPinId +
                  "&fields=pins:PIN|board:BOARD_DETAIL|check";

        fetch(url, { credentials: "include" })
          .then(function(resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
          })
          .then(function(data) {
            var pins = data.pins || [];
            if (pins.length === 0) {
              resolve(allPins);
              return;
            }

            pins.forEach(function(pin) {
              if (!pin.file || !pin.file.url) return;
              allPins.push({
                pin_id: pin.pin_id,
                url: pin.file.url,
                fileKey: pin.file.key,
                fileType: pin.file.type,
                width: pin.file.width || 0,
                height: pin.file.height || 0,
                text: pin.raw_text || "",
                title: pin.title || "",
                description: pin.description || "",
                tags: pin.tags || [],
                isCopyright: !!(pin.is_copyright || pin.copyright_material || pin.is_copyright_material)
              });
            });

            // 上报进度
            safeSend({ action: "COLLECT_PROGRESS", current: allPins.length, total: allPins.length });

            lastPinId = pins[pins.length - 1].pin_id;
            // 继续加载下一页
            loadNext();
          })
          .catch(function(err) {
            console.warn("[HUABAN DL] API 加载失败:", err.message);
            resolve(allPins); // 返回已加载的
          });
      }

      // 如果 SSR 已经包含所有 pin（pin_count <= 40），直接返回
      if (allPins.length > 0) {
        loadNext();
      } else {
        resolve(allPins);
      }
    });
  }

  // ── 覆盖层系统 ─────────────────────────────────
  var pinSelectionState = new Map(); // pin_id → boolean
  var defaultSelectionState = true;  // 新加载 pin 的默认选中状态（全选/全不选后同步）
  var currentBoardData = null;   // 画板信息缓存
  var currentPinData = null;     // Pin 详情页主 pin 数据缓存
  var currentPinId = null;       // 当前 Pin 详情页的 pin_id
  var recommendedPinDataMap = {}; // pin_id → 推荐 pin 完整数据（从 inject.js 或 API 获取）
  var overlayObserver = null;
  // 花瓣是 SPA；每次路由切换都会让之前页面的延迟任务立即失效。
  // 否则从首页进入 Pin 页时，两套扫描器会同时改写新页面 DOM。
  var pageGeneration = 0;

  function isCurrentPage(generation, expectedType) {
    return generation === pageGeneration && (!expectedType || detectPageType() === expectedType);
  }

  function findPinCardFromLink(link) {
    if (!link) return null;
    // 优先选择花瓣瀑布流的直接卡片。不再使用过于宽泛的
    // [class*="pin"] / [class*="item"]，它们在 Pin 详情页可能命中整个页面容器。
    var card = link.closest('[class*="wfc-item"], [class*="waterfall-item"], [class*="PinCard"], [class*="pin-card"], [class*="pinCard"]');
    if (card) return card;

    var node = link;
    for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      if (node !== link && node.querySelectorAll && node.querySelectorAll('a[href*="/pins/"]').length === 1 &&
          node.querySelector('img, picture, video')) return node;
    }
    return link.parentElement && link.parentElement.querySelector('img, picture, video') ? link.parentElement : null;
  }

  function detailImageActionText(node) {
    return String(node && node.textContent || "").replace(/\s+/g, "").trim();
  }

  // Pin 详情页主图上的“复制图片 / 下载图片 / 保存到 Eagle”操作条
  // 来自“好采助手”的 .hc-huaban-btns 会每 800ms 检查并重新注入。
  // 不能直接 remove，否则两个扩展会反复删除/重建；保留空宿主并彻底隐藏，
  // 对未知版本的操作条再使用文字匹配移除作为兜底。
  function removePinDetailImageActions() {
    if (detectPageType() !== "pin") return 0;
    var knownBars = document.querySelectorAll(".hc-huaban-btns");
    knownBars.forEach(function(node) {
      node.hidden = true;
      node.setAttribute("aria-hidden", "true");
      node.style.setProperty("display", "none", "important");
    });
    if (knownBars.length) return knownBars.length;

    var labels = ["复制图片", "下载图片", "保存到Eagle"];
    var seeds = [];
    document.querySelectorAll('button, a, [role="button"], span, div').forEach(function(node) {
      if (labels.indexOf(detailImageActionText(node)) !== -1) seeds.push(node);
    });
    var removed = 0;
    seeds.some(function(seed) {
      var node = seed;
      for (var depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
        var text = detailImageActionText(node);
        if (labels.every(function(label) { return text.indexOf(label) !== -1; })) {
          node.remove();
          removed++;
          return true;
        }
      }
      return false;
    });
    return removed;
  }

  function findMainPinImage(pin) {
    var pinId = String(pin && pin.pin_id || "");
    var fileKey = String(pin && (pin.fileKey || pin.url) || "").split("?")[0].split("/").pop();
    var candidates = [];
    document.querySelectorAll('main img[src], main img[srcset], img[src*="hbimg"], img[src*="huabanimg"]').forEach(function(img) {
      var source = img.currentSrc || img.src || "";
      if (!/(?:hbimg|huabanimg)/i.test(source)) return;
      var width = img.naturalWidth || img.width || 0;
      var height = img.naturalHeight || img.height || 0;
      if (width < 180 || height < 180) return;
      var link = img.closest('a[href*="/pins/"]');
      var match = link && link.href.match(/\/pins\/(\d+)/);
      if (match && match[1] !== pinId) return;
      var rect = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: width, height: height };
      var score = Math.max(width * height, (rect.width || 0) * (rect.height || 0));
      if (fileKey && source.indexOf(fileKey) !== -1) score += 1000000000;
      if (!link) score += 100000000;
      candidates.push({ img: img, score: score });
    });
    candidates.sort(function(a, b) { return b.score - a.score; });
    return candidates.length ? candidates[0].img : null;
  }

  function mainPinCardForImage(img) {
    if (!img) return null;
    var host = img.parentElement;
    while (host && /^(PICTURE|SOURCE|IMG)$/i.test(host.tagName || "")) host = host.parentElement;
    return host && host !== document.body ? host : null;
  }

  function scanVisiblePinOverlays(excludedPinId) {
    if (!pluginEnabled) return 0;
    var pins = [];
    var seen = {};
    document.querySelectorAll('a[href*="/pins/"]').forEach(function(link) {
      var match = link.href.match(/\/pins\/(\d+)/);
      if (!match || match[1] === String(excludedPinId || "") || seen[match[1]]) return;
      if (!findPinCardFromLink(link)) return;
      seen[match[1]] = true;
      if (!recommendedPinDataMap[match[1]]) recommendedPinDataMap[match[1]] = { pin_id: parseInt(match[1]) };
      pins.push({ pin_id: parseInt(match[1]) });
    });
    return pins.length ? addPinOverlays(pins) : 0;
  }

  function setSelectionMode(mode) {
    selectionMode = mode === "manual" ? "manual" : "auto";
    document.documentElement.classList.toggle("huaban-dl-manual-mode", selectionMode === "manual");
    defaultSelectionState = selectionMode !== "manual";
    if (typeof pinSelectionState === "undefined") return;
    manualAcceptedPins.clear();
    manualDeselectedPins.clear();
    if (selectionMode === "manual") manualFilterOverridePins.forEach(function(pid) { manualAcceptedPins.add(pid); });
    pinSelectionState.forEach(function(_value, pid) {
      var classification = filterResults.get(String(pid));
      var allowedByFilter = !(classification && classification.state !== "accepted") ||
        (selectionMode === "manual" && manualFilterOverridePins.has(String(pid)));
      var choose = selectionMode === "manual" ? manualSelectedPins.has(String(pid)) && allowedByFilter : allowedByFilter;
      pinSelectionState.set(String(pid), choose);
      var card = findPinCard(String(pid));
      if (card) {
        card.classList.toggle("huaban-dl-selected", choose);
        card.classList.toggle("huaban-dl-deselected", !choose);
        var badge = card.querySelector(".huaban-dl-badge");
        if (badge) badge.textContent = choose ? "\u2713" : (selectionMode === "manual" ? "" : "\u2717");
      }
    });
    pinSelectionState.forEach(function(_value, pid) { setCardFilterAppearance(String(pid)); });
    if (selectionMode === "manual") {
      var pendingIds = [];
      pinSelectionState.forEach(function(choose, pid) { if (!choose) pendingIds.push(pid); });
      removePendingPins(pendingIds);
      var rememberedIds = Array.from(manualSelectedPins);
      restorePendingPins(rememberedIds);
    }
    else restorePendingPins(Array.from(pinSelectionState.keys()));
    lastSelectionMessage = "";
    updateSelectionCount();
  }

  function addPinOverlayToCard(pin, card) {
    if (!pin || !card) return 0;
    var pid = String(pin.pin_id);
    directPinCards.set(pid, card);
    if (card.classList.contains("huaban-dl-card")) return 0;

    // 首页、搜索、画板和详情主图共用完全相同的选中状态。
    var isSelected;
    if (pinSelectionState.has(pid)) isSelected = pinSelectionState.get(pid);
    else {
      isSelected = selectionMode === "manual" ? manualSelectedPins.has(pid) : defaultSelectionState;
      pinSelectionState.set(pid, isSelected);
    }
    card.classList.add("huaban-dl-card");
    card.classList.add(isSelected ? "huaban-dl-selected" : "huaban-dl-deselected");

    var overlay = document.createElement("div");
    overlay.className = "huaban-dl-overlay";
    card.style.position = "relative";
    card.appendChild(overlay);

    var badge = document.createElement("div");
    badge.className = "huaban-dl-badge";
    badge.textContent = isSelected ? "\u2713" : (selectionMode === "manual" ? "" : "\u2717");
    badge.dataset.pinId = pid;
    card.appendChild(badge);

    badge.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleCardSelection(card, badge, pid);
    });
    card.addEventListener("contextmenu", function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleCardSelection(card, badge, pid);
    });

    knownPins.set(pid, pin);
    setCardFilterAppearance(pid);
    schedulePinClassification(pin);
    return 1;
  }

  function addMainPinOverlay(pin) {
    if (!pluginEnabled || !pin || detectPageType() !== "pin") return 0;
    var img = findMainPinImage(pin);
    return addPinOverlayToCard(pin, mainPinCardForImage(img));
  }

  function addPinOverlays(pins) {
    if (!pluginEnabled) return 0;
    var cardElements = document.querySelectorAll('a[href*="/pins/"]');
    var hrefMap = {};

    cardElements.forEach(function(a) {
      var match = a.href.match(/\/pins\/(\d+)/);
      if (match) {
        var pid = match[1];
        var card = findPinCardFromLink(a);
        if (card && !hrefMap[pid]) hrefMap[pid] = card;
      }
    });

    var matched = 0;
    pins.forEach(function(pin) {
      matched += addPinOverlayToCard(pin, hrefMap[String(pin.pin_id)]);
    });
    updateSelectionCount();
    return matched;
  }

  function toggleCardSelection(card, badge, pid) {
    var classification = filterResults.get(String(pid));
    card.classList.remove("huaban-dl-filter-suspicious", "huaban-dl-filter-rejected");
    var reason = card.querySelector(".huaban-dl-filter-reason");
    if (reason) reason.remove();
    var isSelected = card.classList.contains("huaban-dl-selected");
    if (isSelected) {
      manualAcceptedPins.delete(String(pid));
      if (selectionMode === "manual") { manualSelectedPins.delete(String(pid)); manualFilterOverridePins.delete(String(pid)); }
      else manualDeselectedPins.add(String(pid));
      card.classList.remove("huaban-dl-selected");
      card.classList.add("huaban-dl-deselected");
      badge.textContent = selectionMode === "manual" ? "" : "\u2717"; // pending/cross
      pinSelectionState.set(pid, false);
      removePendingPins([pid]);
    } else {
      manualDeselectedPins.delete(String(pid));
      if (selectionMode === "manual") manualSelectedPins.add(String(pid));
      if (classification && classification.state !== "accepted") {
        manualAcceptedPins.add(String(pid));
        if (selectionMode === "manual") manualFilterOverridePins.add(String(pid));
        autoExcludedPins.delete(String(pid));
      }
      card.classList.remove("huaban-dl-deselected");
      card.classList.add("huaban-dl-selected");
      badge.textContent = "\u2713"; // checkmark
      pinSelectionState.set(pid, true);
      restorePendingPins([pid]);
    }
    updateSelectionCount();
  }

  function updateSelectionCount() {
    var total = pinSelectionState.size;
    var selected = 0;
    pinSelectionState.forEach(function(v) { if (v) selected++; });
    var stats = getFilterStats();
    var signature = [selected, total, stats.accepted, stats.suspicious, stats.rejected, stats.manualExcluded].join(":");
    if (signature === lastSelectionMessage) return;
    lastSelectionMessage = signature;
    safeSend({ action: "SELECTION_COUNT", selected: selected, total: total, filterStats: stats });
  }

  // ── 并发控制（支持中止） ─────────────────────────
  function runConcurrent(tasks, concurrency, onDone) {
    return new Promise(function(resolve) {
      if (tasks.length === 0) { resolve([]); return; }
      var results = new Array(tasks.length);
      var index = 0, done = 0, aborted = false;
      function next() {
        if (abortFlag) {
          if (!aborted) { aborted = true; resolve(results); }
          return;
        }
        if (index >= tasks.length) return;
        var i = index++;
        tasks[i]()
          .then(function(v) { results[i] = { ok: true, value: v }; })
          .catch(function(e) { results[i] = { ok: false, error: e.message }; })
          .then(function() {
            done++;
            if (onDone) onDone(done, tasks.length, results[i]);
            if (abortFlag) {
              if (!aborted) { aborted = true; resolve(results); }
              return;
            }
            if (done === tasks.length) resolve(results);
            else next();
          });
      }
      for (var j = 0; j < Math.min(concurrency, tasks.length); j++) next();
    });
  }

  // ── 采集：画板页（含推荐 Pin）──────────────────
  function collectFromBoard(boardData, allPins) {
    abortFlag = false;

    classifyPins(allPins).then(function() {
      collectFromBoardReady(boardData, allPins);
    });
  }

  function collectFromBoardReady(boardData, allPins) {

    // 区分画板自有 pin 和推荐 pin
    var boardPinIds = {};
    allPins.forEach(function(p) { boardPinIds[String(p.pin_id)] = true; });

    // 画板自有 pin：筛选选中的
    var selectedPins = allPins.filter(function(pin) {
      return isPinCollectable(pin);
    });

    // 推荐 pin：筛选选中的（不在画板自有 pin 中的）
    var needFetch = [];
    pinSelectionState.forEach(function(isSelected, pid) {
      if (!isSelected) return;
      if (boardPinIds[pid]) return; // 已在画板 pin 中，不重复

      var data = recommendedPinDataMap[pid];
      if (data && data.url) {
        if (!isPinCollectable(data)) return;
        selectedPins.push({
          pin_id: data.pin_id,
          url: data.url,
          fileKey: data.fileKey || "",
          fileType: data.fileType || "",
          width: data.width || 0,
          height: data.height || 0,
          text: data.text || ""
        });
      } else {
        needFetch.push(pid); // 只有 pin_id，需要 API 获取完整数据
      }
    });

    if (selectedPins.length === 0 && needFetch.length === 0) {
      safeSend({ action: "ERROR", message: "没有选中任何 Pin" });
      return;
    }

    function doSend() {
      safeSend({ action: "COLLECT_START", total: selectedPins.length });
      chrome.runtime.sendMessage({
        action: "ADD_IMAGES",
        boardInfo: {
          boardId: boardData.board_id,
          boardTitle: boardData.title,
          creator: boardData.description || "",
          sourceUrl: location.href
        },
        pins: selectedPins
      }, function(resp) {
        if (chrome.runtime.lastError) {
          safeSend({ action: "ERROR", message: "存储失败" });
          return;
        }
        removePendingPins(Array.from(manualDeselectedPins));
        syncRejectedQueue();
        safeSend({
          action: "COLLECT_DONE",
          ok: 1,
          fail: 0,
          added: resp ? resp.added : selectedPins.length,
          skipped: resp ? resp.skipped : 0
        });
      });
    }

    if (needFetch.length === 0) {
      doSend();
      return;
    }

    // 需要通过 API 获取推荐 pin 的完整数据
    safeSend({ action: "COLLECT_START", total: needFetch.length });
    var tasks = needFetch.map(function(pid) {
      return function() { return fetchPinByApi(pid); };
    });

    runConcurrent(tasks, 6, function(done, total) {
      safeSend({ action: "COLLECT_PROGRESS", current: done, total: total });
    }).then(function(results) {
      results.forEach(function(r) {
        if (r && r.ok && r.value) {
          applyMetadataClassification(r.value);
          if (isPinCollectable(r.value)) selectedPins.push(r.value);
          recommendedPinDataMap[String(r.value.pin_id)] = r.value;
        }
      });
      doSend();
    });
  }

  // ── 采集：搜索页 ──────────────────────────────
  function collectFromSearch() {
    abortFlag = false;

    // 从 URL 提取搜索关键词
    var params = new URLSearchParams(location.search);
    var query = params.get("q") || params.get("word") || "";
    var isHome = detectPageType() === "home";
    if (!query && !isHome) { safeSend({ action: "ERROR", message: "未找到搜索关键词" }); return; }
    if (!query) query = "首页";

    // 搜索页只以用户实际滚动、看到并勾选的 Pin 为采集白名单。
    // 不再把搜索 API 的全部结果自动视为选中。
    var selectedIds = [];
    pinSelectionState.forEach(function(isSelected, pid) {
      if (!isSelected) return;
      var candidate = knownPins.get(pid) || recommendedPinDataMap[pid] || { pin_id: Number(pid) };
      enrichCopyrightFromCard(candidate);
      var metadata = HuabanFilter.classifyMetadata(candidate, filterSettings);
      filterResults.set(pid, metadata);
      if (metadata.state !== "accepted") {
        pinSelectionState.set(pid, false);
        setCardFilterAppearance(pid);
        return;
      }
      selectedIds.push(pid);
    });

    if (selectedIds.length === 0) {
      updateSelectionCount();
      safeSend({ action: "ERROR", message: "没有选中可采集的 Pin" });
      return;
    }

    safeSend({ action: "COLLECT_START", total: selectedIds.length });
    var tasks = selectedIds.map(function(pid) {
      return function() {
        var cached = recommendedPinDataMap[pid];
        return cached && cached.url ? Promise.resolve(cached) : fetchPinByApi(pid);
      };
    });

    runConcurrent(tasks, 6, function(done, total) {
      safeSend({ action: "COLLECT_PROGRESS", current: done, total: total });
    }).then(function(results) {
      if (abortFlag) {
        safeSend({ action: "ABORTED", phase: "collect", processed: results.length, total: selectedIds.length });
        return;
      }
      var selectedPins = [];
      results.forEach(function(entry) {
        if (!entry || !entry.ok || !entry.value) return;
        var pin = entry.value;
        enrichCopyrightFromCard(pin);
        var metadata = HuabanFilter.classifyMetadata(pin, filterSettings);
        filterResults.set(String(pin.pin_id), metadata);
        if (metadata.state !== "accepted") {
          pinSelectionState.set(String(pin.pin_id), false);
          setCardFilterAppearance(String(pin.pin_id));
          return;
        }
        selectedPins.push(pin);
      });
      updateSelectionCount();
      chrome.runtime.sendMessage({
        action: "ADD_IMAGES",
        boardInfo: { boardId: (isHome ? "home_" : "search_") + query, boardTitle: isHome ? "花瓣首页" : "搜索: " + query, creator: "", sourceUrl: location.href },
        pins: selectedPins
      }, function(resp) {
        if (chrome.runtime.lastError) {
          safeSend({ action: "ERROR", message: "存储失败" });
          return;
        }
        removePendingPins(Array.from(manualDeselectedPins));
        syncRejectedQueue();
        safeSend({
          action: "COLLECT_DONE", ok: 1, fail: results.length - selectedPins.length,
          added: resp ? resp.added : selectedPins.length,
          skipped: resp ? resp.skipped : 0,
          filterStats: getFilterStats()
        });
      });
    });
  }

  // ── 采集：Pin 详情页（主 pin + 选中的推荐 pin） ──
  function collectFromPin(pinData) {
    if (!pinData || !pinData.url) {
      safeSend({ action: "ERROR", message: "未找到图片数据" });
      return;
    }

    abortFlag = false;

    // 主 pin 也必须通过过滤；红色/黄色默认不进入采集队列。
    applyMetadataClassification(pinData);
    var pinsToCollect = isPinCollectable(pinData) ? [{
      pin_id: pinData.pin_id,
      url: pinData.url,
      fileKey: pinData.fileKey,
      fileType: pinData.fileType,
      width: pinData.width,
      height: pinData.height,
      text: pinData.text
    }] : [];

    // 收集选中的推荐 pin
    var needFetch = []; // 只有 pin_id，需要 API 获取完整数据
    pinSelectionState.forEach(function(isSelected, pid) {
      if (!isSelected) return;
      if (pid === String(pinData.pin_id)) return; // 跳过主 pin（已加入）

      var data = recommendedPinDataMap[pid];
      if (data && data.url) {
        if (!isPinCollectable(data)) return;
        pinsToCollect.push({
          pin_id: data.pin_id,
          url: data.url,
          fileKey: data.fileKey || "",
          fileType: data.fileType || "",
          width: data.width || 0,
          height: data.height || 0,
          text: data.text || ""
        });
      } else {
        needFetch.push(pid);
      }
    });

    if (needFetch.length === 0) {
      // 所有数据就绪，直接发送
      sendCollectedPins(pinsToCollect, pinData);
      return;
    }

    // 需要通过 API 获取部分推荐 pin 的完整数据
    safeSend({ action: "COLLECT_START", total: needFetch.length });

    var tasks = needFetch.map(function(pid) {
      return function() { return fetchPinByApi(pid); };
    });

    runConcurrent(tasks, 6, function(done, total) {
      safeSend({ action: "COLLECT_PROGRESS", current: done, total: total });
    }).then(function(results) {
      results.forEach(function(r) {
        if (r && r.ok && r.value) {
          applyMetadataClassification(r.value);
          if (isPinCollectable(r.value)) pinsToCollect.push(r.value);
          // 缓存供后续使用
          recommendedPinDataMap[String(r.value.pin_id)] = r.value;
        }
      });
      sendCollectedPins(pinsToCollect, pinData);
    });
  }

  function sendCollectedPins(pins, mainPin) {
    if (pins.length === 0) {
      safeSend({ action: "ERROR", message: "没有可采集的图片" });
      return;
    }

    chrome.runtime.sendMessage({
      action: "ADD_IMAGES",
      boardInfo: {
        boardId: mainPin.boardId || 0,
        boardTitle: mainPin.boardTitle || "Pin 详情",
        creator: mainPin.creator || "",
        sourceUrl: location.href
      },
      pins: pins
    }, function(resp) {
      if (chrome.runtime.lastError) {
        safeSend({ action: "ERROR", message: "存储失败" });
        return;
      }
      removePendingPins(Array.from(manualDeselectedPins));
      syncRejectedQueue();
      safeSend({
        action: "COLLECT_DONE",
        ok: 1,
        fail: 0,
        added: resp ? resp.added : pins.length,
        skipped: resp ? resp.skipped : 0
      });
    });
  }

  // ── 清理覆盖层 ────────────────────────────────
  function cleanup() {
    pageGeneration++;
    pinSelectionState.clear();
    defaultSelectionState = selectionMode !== "manual"; // 手动模式切页后仍保持待选择
    currentBoardData = null;
    currentPinData = null;
    currentPinId = null;
    recommendedPinDataMap = {};
    filterResults.clear();
    autoExcludedPins.clear();
    knownPins.clear();
    directPinCards.clear();
    filterWork.clear();
    hydrationWork.clear();
    if (overlayObserver) { overlayObserver.disconnect(); overlayObserver = null; }

    document.querySelectorAll(".huaban-dl-overlay, .huaban-dl-badge").forEach(function(el) {
      el.remove();
    });
    document.querySelectorAll(".huaban-dl-card").forEach(function(el) {
      el.classList.remove("huaban-dl-card", "huaban-dl-selected", "huaban-dl-deselected",
        "huaban-dl-filter-suspicious", "huaban-dl-filter-rejected");
    });
    var toast = document.getElementById("huaban-dl-toast");
    if (toast) toast.remove();
  }

  // ── SPA 路由变化检测（增强版）──────────────────
  var lastUrl = window.location.href;
  var pageInitInProgress = false;

  function checkUrlChange() {
    var currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      console.log("[HUABAN DL] URL 变化:", lastUrl, "->", currentUrl);
      lastUrl = currentUrl;
      cleanup();
      // 延迟初始化，等待页面内容更新
      if (!pageInitInProgress) {
        pageInitInProgress = true;
        setTimeout(function() {
          pageInitInProgress = false;
          initPage();
        }, 1200);
      }
    }
  }

  // 1. 轮询检测（兜底，每 500ms）
  var urlCheckTimer = setInterval(checkUrlChange, 500);

  // 2. popstate 事件（浏览器前进/后退）
  window.addEventListener("popstate", function() {
    setTimeout(checkUrlChange, 100);
  });

  // 3. 接收 MAIN world 的 pushState/replaceState 通知（url-watcher.js 发的）
  // content script 在 ISOLATED world，无法直接拦截页面的 pushState
  // 必须通过 MAIN world 脚本拦截后用 postMessage 通知
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "__HUABAN_URL_CHANGE__") {
      console.log("[HUABAN DL] 收到 MAIN world pushState 通知:", event.data.url);
      setTimeout(checkUrlChange, 50);
    }
  });

  // ── 页面初始化 ────────────────────────────────
  // 存储画板页加载的所有 pin（供采集时使用）
  var boardAllPins = [];

  function initPage() {
    if (!pluginEnabled) return;
    var generation = pageGeneration;
    var pageType = detectPageType();
    console.log("[HUABAN DL] initPage:", pageType, location.href);
    safeSend({ action: "PAGE_TYPE", pageType: pageType });

    if (pageType === "board") {
      initBoardPage();
    } else if (pageType === "search" || pageType === "home") {
      // 搜索页：不主动加载，等用户点"采集"时通过 API 加载
      // 但尝试给已渲染的卡片加覆盖层
      setTimeout(function() {
        if (isCurrentPage(generation, pageType)) tryAddSearchOverlays(generation);
      }, 1000);
    } else if (pageType === "pin") {
      initPinPage(generation);
    }
  }

  // 通过 API 加载画板信息（SPA 跳转兜底）
  function fetchBoardByApi(boardId) {
    return fetch("/v3/boards/" + boardId + "/pins?limit=40&sort=seq&fields=pins:PIN|board:BOARD_DETAIL|check",
      { credentials: "include" })
      .then(function(resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function(data) {
        var board = data.board || {};
        var pins = (data.pins || []).map(function(pin) {
          if (!pin.file || !pin.file.url) return null;
          return {
            pin_id: pin.pin_id,
            url: pin.file.url,
            fileKey: pin.file.key,
            fileType: pin.file.type,
            width: pin.file.width || 0,
            height: pin.file.height || 0,
            text: pin.raw_text || "",
            title: pin.title || "",
            description: pin.description || "",
            tags: pin.tags || [],
            isCopyright: !!(pin.is_copyright || pin.copyright_material || pin.is_copyright_material)
          };
        }).filter(Boolean);
        return { board: board, pins: pins };
      });
  }

  // ── 画板页：扫描推荐 Pin（"更多采集推荐"区域）────
  // 推荐 pin 的 pin_id 不在 boardAllPins 中，需要单独扫描
  function scanBoardRecommendedPins() {
    var boardPinIds = {};
    boardAllPins.forEach(function(p) { boardPinIds[String(p.pin_id)] = true; });

    var links = document.querySelectorAll('a[href*="/pins/"]');
    var extraPins = [];
    var seen = {};

    links.forEach(function(a) {
      var match = a.href.match(/\/pins\/(\d+)/);
      if (!match) return;
      var pid = match[1];
      if (boardPinIds[pid] || seen[pid]) return;
      seen[pid] = true;

      if (!recommendedPinDataMap[pid]) {
        recommendedPinDataMap[pid] = { pin_id: parseInt(pid) };
      }
      extraPins.push({ pin_id: parseInt(pid) });
    });

    if (extraPins.length > 0) {
      addPinOverlays(extraPins);
    }
  }

  // ── 画板页：设置 MutationObserver（带去抖）────
  function setupBoardObserver() {
    if (overlayObserver) overlayObserver.disconnect();
    overlayObserver = new MutationObserver(function() {
      clearTimeout(overlayObserver._debounce);
      overlayObserver._debounce = setTimeout(function() {
        if (boardAllPins.length > 0) {
          addPinOverlays(boardAllPins);
        }
        // 同时扫描推荐区域的 pin
        scanBoardRecommendedPins();
      }, 300);
    });
    var container = document.querySelector('[class*="waterfall"]') ||
                    document.querySelector('main') ||
                    document.body;
    overlayObserver.observe(container, { childList: true, subtree: true });
    // 初次延迟扫描推荐区域
    setTimeout(scanBoardRecommendedPins, 2000);
  }

  function initBoardPage() {
    var boardIdMatch = location.pathname.match(/\/boards\/(\d+)/);
    var boardId = boardIdMatch ? boardIdMatch[1] : null;

    extractPageData().then(function(data) {
      if (data.error || data.pageType !== "board") {
        console.log("[HUABAN DL] __NEXT_DATA__ 无画板数据（可能是 SPA 跳转），改用 API");
        if (!boardId) return;
        fetchBoardByApi(boardId).then(function(result) {
          currentBoardData = result.board;
          boardAllPins = result.pins;

          safeSend({
            action: "BOARD_INFO",
            title: result.board.title || "画板",
            pinCount: result.board.pin_count || result.pins.length
          });

          setTimeout(function() { addPinOverlays(boardAllPins); }, 500);

          if ((result.board.pin_count || 0) > boardAllPins.length) {
            loadAllBoardPins(boardId, boardAllPins).then(function(allPins) {
              boardAllPins = allPins;
              addPinOverlays(allPins);
            });
          }

          setupBoardObserver();
        }).catch(function(err) {
          console.warn("[HUABAN DL] API 获取画板失败:", err.message);
        });
        return;
      }

      currentBoardData = data.board;
      boardAllPins = data.pins.slice(); // SSR 的前 40 个
      var totalPinCount = data.board.pin_count || boardAllPins.length;

      safeSend({
        action: "BOARD_INFO",
        title: data.board.title,
        pinCount: totalPinCount
      });

      // 给 SSR 渲染的 pin 卡片加覆盖层
      setTimeout(function() {
        addPinOverlays(boardAllPins);
      }, 500);

      // 如果画板有超过 40 个 pin，自动通过 API 加载剩余的
      if (totalPinCount > boardAllPins.length) {
        loadAllBoardPins(data.board.board_id, boardAllPins).then(function(allPins) {
          boardAllPins = allPins;
          safeSend({
            action: "BOARD_INFO",
            title: data.board.title,
            pinCount: allPins.length
          });
          // 持续给新加载的 pin 添加覆盖层
          addPinOverlays(allPins);
        });
      }

      setupBoardObserver();
    });
  }

  // 通过 API 获取单个 Pin 数据（SPA 跳转时 __NEXT_DATA__ 不更新，需要用 API 兜底）
  function fetchPinByApi(pinId) {
    return fetch("/v3/pins/" + pinId, { credentials: "include" })
      .then(function(resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function(data) {
        if (!data.pin || !data.pin.file) throw new Error("no pin data");
        var pin = data.pin;
        return {
          pin_id: pin.pin_id,
          url: pin.file.url,
          fileKey: pin.file.key,
          fileType: pin.file.type,
          width: pin.file.width || 0,
          height: pin.file.height || 0,
          text: pin.raw_text || "",
          title: pin.title || "",
          description: pin.description || "",
          tags: pin.tags || [],
          isCopyright: !!(pin.is_copyright || pin.copyright_material || pin.is_copyright_material),
          boardId: pin.board_id || (pin.board && pin.board.board_id) || 0,
          boardTitle: (pin.board && pin.board.title) || "",
          creator: (pin.user && pin.user.username) || ""
        };
      });
  }

  function initPinPage(generation) {
    // 从 URL 提取 pin_id
    var pinIdMatch = location.pathname.match(/\/pins\/(\d+)/);
    var pinId = pinIdMatch ? pinIdMatch[1] : null;
    currentPinId = pinId;
    console.log("[HUABAN DL] initPinPage, pinId:", pinId);
    removePinDetailImageActions();
    [300, 1000, 2500].forEach(function(delay) {
      setTimeout(function() {
        if (isCurrentPage(generation, "pin") && currentPinId === pinId) removePinDetailImageActions();
      }, delay);
    });

    if (!pinId) {
      safeSend({ action: "ERROR", message: "无法识别 Pin ID" });
      return;
    }

    // 先尝试从 __NEXT_DATA__ 获取（首次加载/刷新后有效）
    extractPageData().then(function(data) {
      if (!isCurrentPage(generation, "pin") || currentPinId !== pinId) return;
      if (data.error || data.pageType !== "pin") {
        console.log("[HUABAN DL] __NEXT_DATA__ 无 Pin 数据（SPA 跳转），改用 API");
        // 用 API 获取
        fetchPinByApi(pinId).then(function(pinData) {
          if (!isCurrentPage(generation, "pin") || currentPinId !== pinId) return;
          currentPinData = pinData;
          addMainPinOverlay(pinData);
          safeSend({
            action: "PIN_INFO",
            text: pinData.text || "图片 " + pinData.pin_id
          });
          // 加载推荐 pin
          loadRecommendedPins(pinId, generation);
        }).catch(function(err) {
          if (!isCurrentPage(generation, "pin") || currentPinId !== pinId) return;
          console.warn("[HUABAN DL] API 获取 Pin 失败:", err.message, "，2秒后重试...");
          // 重试一次（页面可能还在加载中）
          setTimeout(function() {
            if (!isCurrentPage(generation, "pin") || currentPinId !== pinId) return;
            fetchPinByApi(pinId).then(function(pinData) {
              if (!isCurrentPage(generation, "pin") || currentPinId !== pinId) return;
              currentPinData = pinData;
              addMainPinOverlay(pinData);
              safeSend({
                action: "PIN_INFO",
                text: pinData.text || "图片 " + pinData.pin_id
              });
              loadRecommendedPins(pinId, generation);
            }).catch(function(err2) {
              console.warn("[HUABAN DL] 重试也失败:", err2.message);
              safeSend({ action: "ERROR", message: "获取 Pin 数据失败，请刷新重试" });
            });
          }, 2000);
        });
        return;
      }

      // __NEXT_DATA__ 有效
      currentPinData = data.pin;
      addMainPinOverlay(data.pin);
      safeSend({
        action: "PIN_INFO",
        text: data.pin.text || "图片 " + data.pin.pin_id
      });

      // 如果 inject.js 提供了推荐 pin 数据，先缓存
      if (data.recommendedPins && data.recommendedPins.length > 0) {
        data.recommendedPins.forEach(function(rp) {
          recommendedPinDataMap[String(rp.pin_id)] = rp;
        });
        console.log("[HUABAN DL] 从 __NEXT_DATA__ 获取", data.recommendedPins.length, "个推荐 pin 数据");
      }

      // 加载推荐 pin（DOM 扫描 + 覆盖层）
      loadRecommendedPins(pinId, generation);
    });
  }

  // ── 加载推荐 Pin 并添加覆盖层 ─────────────────
  // 关键：不能用 pinSelectionState.has(pid) 跳过扫描！
  // 因为花瓣用虚拟滚动，DOM 元素会被回收重建，
  // 旧的 pinSelectionState 记录还在，但新 DOM 没有覆盖层。
  // 必须让 addPinOverlays 通过 card.classList 检查来判断是否需要重建。
  function loadRecommendedPins(mainPinId, generation) {
    var scanCount = 0;
    var maxScans = 6; // 最多扫描 6 次（共等约 9 秒）

    function scanAndOverlay() {
      if (!isCurrentPage(generation, "pin") || currentPinId !== mainPinId) return;
      scanCount++;
      removePinDetailImageActions();
      addMainPinOverlay(currentPinData);
      var matched = scanVisiblePinOverlays(mainPinId);

      if (matched > 0) {

        // 统计推荐 pin 总数（排除主 pin）
        var recCount = 0;
        pinSelectionState.forEach(function(v, k) {
          if (k !== mainPinId) recCount++;
        });
        safeSend({ action: "RECOMMENDED_COUNT", count: recCount });
      }

      // 继续扫描（推荐区域可能是延迟加载的）
      if (scanCount < maxScans) {
        setTimeout(scanAndOverlay, 1500);
      }
    }

    // 首次扫描延迟 1.5 秒（等 DOM 渲染）
    setTimeout(scanAndOverlay, 1500);

    // 同时用 MutationObserver 监听新增/回收重建的推荐卡片
    if (overlayObserver) overlayObserver.disconnect();
    overlayObserver = new MutationObserver(function() {
      // 去抖动：200ms 内多次变化只触发一次
      clearTimeout(overlayObserver._debounce);
      overlayObserver._debounce = setTimeout(function() {
        if (!isCurrentPage(generation, "pin") || currentPinId !== mainPinId) return;
        removePinDetailImageActions();
        addMainPinOverlay(currentPinData);
        var matched = scanVisiblePinOverlays(mainPinId);
        if (matched > 0) {
          var recCount = 0;
          pinSelectionState.forEach(function(v, k) {
            if (k !== mainPinId) recCount++;
          });
          safeSend({ action: "RECOMMENDED_COUNT", count: recCount });
        }
      }, 200);
    });
    var container = document.querySelector('main') || document.body;
    overlayObserver.observe(container, { childList: true, subtree: true });
  }

  // 搜索页：尝试给已渲染的卡片加覆盖层（不加载 API 数据，只是标记 DOM）
  function tryAddSearchOverlays(generation) {
    var pageType = detectPageType();
    if (!pluginEnabled || !isCurrentPage(generation, pageType) || (pageType !== "home" && pageType !== "search")) return;
    scanVisiblePinOverlays(null);

    // 监听 DOM 变化（无限滚动），带去抖防卡顿
    if (!overlayObserver) {
      overlayObserver = new MutationObserver(function() {
        clearTimeout(overlayObserver._debounce);
        overlayObserver._debounce = setTimeout(function() { tryAddSearchOverlays(generation); }, 300);
      });
      var container = document.querySelector('[class*="waterfall"]') ||
                      document.querySelector('main') ||
                      document.body;
      overlayObserver.observe(container, { childList: true, subtree: true });
    }
  }

  // ── 消息监听（来自 popup / background） ────────
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

    if (msg.action === "UPDATE_PLUGIN_ENABLED") {
      setPluginEnabled(msg.enabled); sendResponse({ ok: true, enabled: pluginEnabled }); return;
    }

    if (msg.action === "DETECT_PAGE") {
      var pt = detectPageType();
      var resp = { pageType: pt };
      if (pt === "board" && currentBoardData) {
        resp.boardTitle = currentBoardData.title;
      }
      if (pt === "pin") {
        // 告诉 popup 有多少推荐 pin
        var recCount = 0;
        if (currentPinId) {
          pinSelectionState.forEach(function(v, k) {
            if (k !== currentPinId) recCount++;
          });
        }
        resp.recommendedCount = recCount;
      }
      sendResponse(resp);
      return;
    }

    if (msg.action === "COLLECT") {
      if (!pluginEnabled) { safeSend({ action: "ERROR", message: "插件已关闭" }); sendResponse({ started: false }); return; }
      var pageType = detectPageType();
      if (pageType === "board") {
        if (!currentBoardData) {
          safeSend({ action: "ERROR", message: "画板数据未加载，请刷新页面" });
        } else {
          collectFromBoard(currentBoardData, boardAllPins);
        }
      } else if (pageType === "search" || pageType === "home") {
        collectFromSearch();
      } else if (pageType === "pin") {
        if (!currentPinData) {
          safeSend({ action: "ERROR", message: "Pin 数据未加载，请刷新页面" });
        } else {
          collectFromPin(currentPinData);
        }
      } else {
        safeSend({ action: "ERROR", message: "当前页面不支持采集" });
      }
      sendResponse({ started: true });
      return;
    }

    // ── 全选/全不选 ─────────────────────────────────
    if (msg.action === "SELECT_ALL") {
      defaultSelectionState = true; // 后续懒加载的 pin 也默认选中
      pinSelectionState.forEach(function(v, k) {
        manualDeselectedPins.delete(String(k));
        var classification = filterResults.get(String(k));
        pinSelectionState.set(k, manualAcceptedPins.has(String(k)) || !(classification && classification.state !== "accepted"));
      });
      document.querySelectorAll(".huaban-dl-card").forEach(function(el) {
        var badge = el.querySelector(".huaban-dl-badge");
        var pid = badge && badge.dataset.pinId;
        var classification = pid && filterResults.get(String(pid));
        if (classification && classification.state !== "accepted" && !manualAcceptedPins.has(String(pid))) {
          el.classList.remove("huaban-dl-selected");
          el.classList.add("huaban-dl-deselected");
          if (badge) badge.textContent = "\u2717";
        } else {
          el.classList.remove("huaban-dl-deselected");
          el.classList.add("huaban-dl-selected");
          if (badge) badge.textContent = "\u2713";
        }
      });
      var restoredIds = [];
      pinSelectionState.forEach(function(isSelected, id) { if (isSelected) restoredIds.push(id); });
      restorePendingPins(restoredIds);
      updateSelectionCount();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "DESELECT_ALL") {
      defaultSelectionState = false; // 后续懒加载的 pin 也默认不选中
      pinSelectionState.forEach(function(v, k) {
        manualAcceptedPins.delete(String(k));
        manualDeselectedPins.add(String(k));
        pinSelectionState.set(k, false);
      });
      removePendingPins(Array.from(pinSelectionState.keys()));
      document.querySelectorAll(".huaban-dl-card").forEach(function(el) {
        el.classList.remove("huaban-dl-selected");
        el.classList.add("huaban-dl-deselected");
        var badge = el.querySelector(".huaban-dl-badge");
        if (badge) badge.textContent = "\u2717";
      });
      updateSelectionCount();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "UPDATE_FILTER_SETTINGS") {
      filterSettings = HuabanFilter.mergeSettings(msg.settings);
      refreshFilterState(!!filterSettings.enabled);
      sendResponse({ ok: true, settings: filterSettings });
      return;
    }

    if (msg.action === "UPDATE_SELECTION_MODE") {
      setSelectionMode(msg.mode);
      sendResponse({ ok: true, mode: selectionMode });
      return;
    }

    // ── 批量下载到文件夹（background 发来的指令） ──
    if (msg.action === "DO_DOWNLOAD") {
      doDownload(msg.images, msg.totalImages, msg.resumeFrom || 0, msg.collectionTitle);
      return;
    }

    // ── 中止任务 ──────────────────────────────────
    if (msg.action === "ABORT") {
      abortFlag = true;
      sendResponse({ ok: true });
      return;
    }
  });

  // ── 下载单张图片 ──────────────────────────────
  async function downloadOneImage(url, fileKey) {
    // 方法 1：直接用带 auth_key 的 URL fetch
    try {
      var resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var blob = await resp.blob();
      if (blob.size > 0) return blob;
    } catch(e) {
      console.log("[HUABAN DL] fetch 失败:", e.message);
    }

    // 方法 2：尝试用不带 auth_key 的 URL（fileKey）
    if (fileKey) {
      try {
        var rawUrl = "https://gd-hbimg-edge.huaban.com/" + fileKey;
        var resp2 = await fetch(rawUrl, { credentials: "include" });
        if (!resp2.ok) throw new Error("HTTP " + resp2.status);
        var blob2 = await resp2.blob();
        if (blob2.size > 0) return blob2;
      } catch(e2) {
        console.log("[HUABAN DL] raw URL 也失败:", e2.message);
      }
    }

    // 方法 3：canvas 兜底
    return imgToBlob(url);
  }

  function imgToBlob(url) {
    return new Promise(function(resolve, reject) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      var timer = setTimeout(function() { reject(new Error("timeout")); }, 30000);
      img.onload = function() {
        clearTimeout(timer);
        try {
          var c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          var mime = "image/jpeg";
          if (url.indexOf(".png") !== -1) mime = "image/png";
          else if (url.indexOf(".webp") !== -1) mime = "image/webp";
          var quality = mime === "image/jpeg" ? 0.95 : undefined;
          c.toBlob(function(blob) {
            if (blob && blob.size > 0) resolve(blob);
            else reject(new Error("toBlob returned null"));
          }, mime, quality);
        } catch(e) { reject(e); }
      };
      img.onerror = function() {
        clearTimeout(timer);
        reject(new Error("image load failed"));
      };
      img.src = url;
    });
  }

  // ── 下载配置 ─────────────────────────────────
  var BATCH_SIZE = 500;    // 分段读取，最终逐文件保存到同一下载文件夹
  var DL_CONCURRENCY = 6;  // 并发下载数

  async function perceptualHashFromBlob(blob) {
    var bitmap = await createImageBitmap(blob);
    try {
      return pixelInfoFromBitmap(bitmap).hash;
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  // ── 流式分批下载 ──────────────────────────────
  async function doDownload(images, totalImages, resumeFrom, collectionTitle) {
    abortFlag = false;
    var downloadStartTime = new Date();

    // 花瓣的 pin 是 1 pin = 1 图，直接按 pin_id 命名并保存到本次采集文件夹。
    var fileList = [];
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var ext = getExtFromType(img.fileType) || getExtFromUrl(img.url);
      var num = String(i + 1);
      while (num.length < 4) num = "0" + num;
      var filename = num + "-" + getDateStr(downloadStartTime) + "-花瓣-" + getOriginalImageName(img) + ext;
      fileList.push({
        url: img.url,
        fileKey: img.fileKey,
        filename: filename
      });
    }

    // 按 BATCH_SIZE 分批
    var batches = [];
    for (var b = 0; b < fileList.length; b += BATCH_SIZE) {
      batches.push(fileList.slice(b, b + BATCH_SIZE));
    }

    var totalBatches = batches.length;
    var startBatch = resumeFrom || 0;

    // 计算已跳过批次的图片数
    var skippedImages = 0;
    for (var s = 0; s < startBatch && s < totalBatches; s++) {
      skippedImages += batches[s].length;
    }

    var globalOk = 0, globalFail = 0;
    var globalProcessed = skippedImages;
    var visualDuplicateCount = 0;
    var seenVisualHashes = [];
    safeSend({ action: "DL_PROGRESS", current: skippedImages, total: totalImages,
               ok: 0, fail: 0, batch: startBatch + 1, totalBatches: totalBatches });

    for (var batch = startBatch; batch < totalBatches; batch++) {
      if (abortFlag) break;

      var batchFiles = batches[batch];
      var downloadedFiles = [];

      // ── 并发下载 ──
      var lastProgressTime = 0;
      await new Promise(function(batchResolve) {
        var nextIdx = 0, doneCount = 0, totalInBatch = batchFiles.length;
        if (totalInBatch === 0) { batchResolve(); return; }

        function startNext() {
          while (nextIdx < totalInBatch && !abortFlag) {
            var idx = nextIdx++;
            (function(f) {
              downloadOneImage(f.url, f.fileKey)
                .then(async function(blob) {
                  try {
                    var hash = await perceptualHashFromBlob(blob);
                    var duplicate = HuabanFilter.isVisualDuplicate(hash, seenVisualHashes, 2);
                    if (duplicate) {
                      visualDuplicateCount++;
                      return;
                    }
                    seenVisualHashes.push(hash);
                  } catch (_error) {
                    // 哈希失败时保留图片，避免视觉检查造成误删。
                  }
                  downloadedFiles.push({ filename: f.filename, blob: blob });
                  globalOk++;
                })
                .catch(function(e) {
                  console.warn("[HUABAN DL] FAIL:", f.filename, e.message);
                  globalFail++;
                })
                .then(function() {
                  doneCount++;
                  globalProcessed++;
                  var now = Date.now();
                  if (doneCount % 5 === 0 || doneCount === totalInBatch || now - lastProgressTime > 500) {
                    lastProgressTime = now;
                    safeSend({
                      action: "DL_PROGRESS",
                      current: globalProcessed,
                      total: totalImages,
                      ok: globalOk, fail: globalFail,
                      batch: batch + 1, totalBatches: totalBatches
                    });
                  }
                  if (abortFlag || doneCount === totalInBatch) {
                    batchResolve();
                  } else {
                    startNext();
                  }
                });
            })(batchFiles[idx]);
            if (nextIdx - doneCount >= DL_CONCURRENCY) break;
          }
        }
        startNext();
      });

      if (abortFlag) {
        safeSend({
          action: "ABORTED", phase: "download",
          processed: globalProcessed,
          total: totalImages, ok: globalOk,
          completedBatches: batch,
          totalBatches: totalBatches
        });
        return;
      }

      if (downloadedFiles.length === 0) continue;

      var folderName = "审美图-" + getDateStr(downloadStartTime) + "-" + totalImages + "张";
      for (var savedIndex = 0; savedIndex < downloadedFiles.length; savedIndex++) {
        var savedOk = await triggerFileDownload(downloadedFiles[savedIndex].blob,
          folderName + "/" + downloadedFiles[savedIndex].filename);
        if (!savedOk) { globalOk--; globalFail++; }
      }

      downloadedFiles = null;

      safeSend({ action: "BATCH_COMPLETE", completedBatches: batch + 1, totalBatches: totalBatches });

      if (batch < totalBatches - 1) {
        await new Promise(function(r) { setTimeout(r, 2000); });
      }
    }

    if (!abortFlag) {
      safeSend({ action: "DL_DONE", ok: globalOk, fail: globalFail,
        visualDuplicates: visualDuplicateCount,
        batches: totalBatches,
        filename: "审美图-" + getDateStr(downloadStartTime) + "-" + globalOk + "张" });
    }
  }

  // ── 将单个文件保存到浏览器下载目录中的指定文件夹 ──
  function triggerFileDownload(fileBlob, filename) {
    return new Promise(function(resolve) {
      var blobUrl = URL.createObjectURL(fileBlob);
      chrome.runtime.sendMessage({
        action: "TRIGGER_DOWNLOAD",
        blobUrl: blobUrl,
        filename: filename,
        saveAs: false
      }, function(resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          URL.revokeObjectURL(blobUrl);
          resolve(false);
          return;
        }
        setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 60000);
        resolve(true);
      });
    });
  }

  // ── 启动：一次性加载设置后初始化，避免首次安装时的异步竞态和重复扫描。 ──
  chrome.storage.local.get(["aesthetic_collector_enabled", "aesthetic_selection_mode"], function(data) {
    setSelectionMode(data.aesthetic_selection_mode === "manual" ? "manual" : "auto");
    setPluginEnabled(data.aesthetic_collector_enabled !== false);
  });

})();
