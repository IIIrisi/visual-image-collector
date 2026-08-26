(function() {
  "use strict";

  var selected = new Map();
  var pins = new Map();
  var observer = null;
  var scanTimer = null;
  var filterEnabled = true;
  var pluginEnabled = true;
  var lastSelectionMessage = "";
  var manualDeselectedPins = new Set();
  var removedPendingPins = new Set();
  var selectionMode = "auto";
  var manualSelectedPins = new Set();
  function setPluginEnabled(enabled) {
    pluginEnabled = enabled !== false;
    document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
    if (pluginEnabled) scan();
  }
  chrome.storage.local.get(["aesthetic_collector_enabled"], function(data) {
    setPluginEnabled(data.aesthetic_collector_enabled !== false);
  });
  chrome.storage.local.get(["aesthetic_selection_mode"], function(data) {
    setSelectionMode(data.aesthetic_selection_mode === "manual" ? "manual" : "auto");
  });

  chrome.storage.local.get(["huaban_filter_settings"], function(data) {
    filterEnabled = !data.huaban_filter_settings || data.huaban_filter_settings.enabled !== false;
  });

  function safeSend(message) {
    try { chrome.runtime.sendMessage(message); } catch (_error) {}
  }

  function setSelectionMode(mode) {
    selectionMode = mode === "manual" ? "manual" : "auto";
    document.documentElement.classList.toggle("huaban-dl-manual-mode", selectionMode === "manual");
    manualDeselectedPins.clear();
    pins.forEach(function(record, id) {
      var allowedByFilter = !(filterEnabled && record.promoted);
      var choose = selectionMode === "manual" ? manualSelectedPins.has(id) && allowedByFilter : allowedByFilter;
      selected.set(id, choose);
      setAppearance(record);
    });
    if (selectionMode === "manual") {
      var pending = [];
      selected.forEach(function(choose, id) { if (!choose) pending.push(id); });
      removePendingPins(pending); restorePendingPins(Array.from(manualSelectedPins));
    }
    else restorePendingPins(Array.from(pins.keys()));
    lastSelectionMessage = "";
    updateCount();
  }

  function removePendingPins(pinIds) {
    var ids = (pinIds || []).map(function(id) { return "pinterest:" + String(id); });
    if (!ids.length) return;
    chrome.runtime.sendMessage({ action: "REMOVE_FILTERED_IMAGES", pinIds: ids }, function(result) {
      if (chrome.runtime.lastError) return;
      if (result && result.removed > 0) {
        var removedIds = (result.removedPinIds || ids).map(function(id) { return String(id).replace(/^pinterest:/, ""); });
        removedIds.forEach(function(id) { removedPendingPins.add(id); });
        safeSend({ action: "PENDING_QUEUE_CHANGED", removed: result.removed });
        restorePendingPins(removedIds.filter(function(id) { return selected.get(id) === true; }));
      }
    });
  }

  function restorePendingPins(pinIds) {
    var output = [];
    (pinIds || []).forEach(function(rawId) {
      var id = String(rawId);
      var record = pins.get(id);
      if (!removedPendingPins.has(id) || !record) return;
      output.push({ pin_id: "pinterest:" + id, url: record.url, fileKey: record.fallbackUrl, fileType: "image/jpeg",
        width: record.width, height: record.height, text: record.title });
    });
    if (!output.length) return;
    chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: {
      boardId: "pinterest_" + pageTitle(), boardTitle: "Pinterest: " + pageTitle(), creator: "Pinterest", sourceUrl: location.href
    }, pins: output }, function(result) {
      if (chrome.runtime.lastError || !result) return;
      output.forEach(function(pin) { removedPendingPins.delete(String(pin.pin_id).replace(/^pinterest:/, "")); });
      safeSend({ action: "PENDING_QUEUE_CHANGED", restored: result.added || 0 });
    });
  }

  function pageType() {
    var path = location.pathname;
    if (/\/pin\/\d+/.test(path)) return "pin";
    if (/\/search\//.test(path)) return "search";
    if (/\/_saved\/?$/.test(path) || /\/[^/]+\/[^/]+\/?$/.test(path)) return "board";
    return "home";
  }

  function pageTitle() {
    var params = new URLSearchParams(location.search);
    var query = params.get("q");
    if (query) return query;
    var heading = document.querySelector("h1");
    return (heading && heading.textContent || document.title || "Pinterest").replace(/\s*\|\s*Pinterest.*$/i, "").trim();
  }

  function largestUrl(img) {
    var srcset = img.getAttribute("srcset") || "";
    var candidates = srcset.split(",").map(function(item) {
      var parts = item.trim().split(/\s+/);
      return { url: parts[0], width: parseInt(parts[1], 10) || 0 };
    }).filter(function(item) { return /^https?:\/\//.test(item.url); });
    candidates.sort(function(a, b) { return b.width - a.width; });
    var fallback = candidates.length ? candidates[0].url : (img.currentSrc || img.src || "");
    return { original: fallback.replace(/\/\d+x\//, "/originals/"), fallback: fallback };
  }

  // 主页和 Pin 详情页的推荐瀑布流共用同一套卡片解析。
  // Pinterest 新版 DOM 中链接有时包住图片，有时才位于 pinWrapper 内部。
  function pinLinkForImage(img) {
    var directLink = img.closest('a[href*="/pin/"]');
    if (directLink) return directLink;
    var context = img.closest('[data-test-id="pinWrapper"]') || img.closest('div[data-grid-item]');
    return context && context.querySelector('a[href*="/pin/"]');
  }

  // Overlay 必须挂在能容纳子节点的可见容器上。Pinterest 有时会把
  // data-test-id 直接放在 img 上；把 div 追加到 img/picture 内部虽不一定报错，
  // 但浏览器不会正常渲染选框。
  function overlayHostForImage(img, preferredHost) {
    var host = preferredHost;
    while (host && (host === img || /^(IMG|PICTURE|SOURCE)$/i.test(host.tagName || ""))) {
      host = host.parentElement;
    }
    if (!host || host === document.body) return null;
    if (typeof host.contains === "function" && !host.contains(img)) return null;
    return host;
  }

  function pinCardForImage(img, link) {
    // 选框必须挂到真正包住图片的可见节点；这也是主页卡片最稳定的锚点。
    if (link && link.contains(img)) return overlayHostForImage(img, link);
    return overlayHostForImage(img,
      img.closest('[data-test-id="pinWrapper"]') || img.closest('div[data-grid-item]'));
  }

  function detailCardForImage(img) {
    if (!img) return null;
    // 详情主图先完整复用首页的链接/卡片定位。visual-content-container
    // 往往包含左右留白、返回键和放大控件，不能作为选框宿主。
    var homepageCard = pinCardForImage(img, pinLinkForImage(img));
    if (homepageCard) return homepageCard;
    return overlayHostForImage(img, img.parentElement);
  }

  function pinIdFor(img, url) {
    var link = pinLinkForImage(img);
    var match = link && link.href.match(/\/pin\/(\d+)/);
    if (match) return match[1];
    var signature = img.closest("[data-test-image-signature]");
    if (signature) return signature.getAttribute("data-test-image-signature");
    var hash = 0;
    for (var i = 0; i < url.length; i++) hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
    return "img_" + Math.abs(hash);
  }

  function detailPinId() {
    var match = location.pathname.match(/\/pin\/(\d+)/);
    return match ? match[1] : "";
  }

  function detailImageCandidate() {
    var selectors = [
      '[data-test-id="pin-closeup-image"] img',
      '[data-test-id="closeup-image"] img',
      '[data-test-id="visual-content-container"] img',
      '[data-test-id="pin-image-container"] img',
      'img[srcset]',
      'img[src*="pinimg.com"]'
    ];
    var candidates = [];
    var seen = new Set();
    document.querySelectorAll(selectors.join(",")).forEach(function(img) {
      if (seen.has(img)) return;
      seen.add(img);
      var source = img.currentSrc || img.src || "";
      if (!/\.pinimg\.com\//.test(source)) return;
      var width = img.naturalWidth || img.width || 0;
      var height = img.naturalHeight || img.height || 0;
      if (width < 180 || height < 180) return;
      var linkedPin = img.closest('a[href*="/pin/"]');
      var linkedMatch = linkedPin && linkedPin.href.match(/\/pin\/(\d+)/);
      if (linkedMatch && linkedMatch[1] !== detailPinId()) return;
      var explicit = img.closest('[data-test-id*="closeup"], [data-test-id="visual-content-container"], [data-test-id="pin-image-container"]');
      candidates.push({ img: img, score: width * height + (explicit ? 100000000 : 0) });
    });
    candidates.sort(function(a, b) { return b.score - a.score; });
    return candidates.length ? candidates[0].img : null;
  }

  function scanDetailPin() {
    if (pageType() !== "pin") return;
    var id = detailPinId();
    if (!id) return;
    var img = detailImageCandidate();
    var urls;
    if (img) {
      urls = largestUrl(img);
    } else {
      var meta = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
      var metaUrl = meta && meta.content || "";
      if (!/\.pinimg\.com\//.test(metaUrl)) return;
      urls = { original: metaUrl.replace(/\/\d+x\//, "/originals/"), fallback: metaUrl };
    }
    if (!/\.pinimg\.com\//.test(urls.original)) return;
    // 与主页卡片共用 overlayHostForImage，同时保留详情页主图的独立定位。
    var card = detailCardForImage(img);
    var titleMeta = document.querySelector('meta[property="og:title"]');
    var title = img && img.alt || titleMeta && titleMeta.content || pageTitle();
    var widthMeta = document.querySelector('meta[property="og:image:width"]');
    var heightMeta = document.querySelector('meta[property="og:image:height"]');
    var record = { id: id, url: urls.original, fallbackUrl: urls.fallback, title: title, card: card,
      detailImage: img || null, promoted: false,
      width: img ? (img.naturalWidth || img.width) : parseInt(widthMeta && widthMeta.content, 10) || 0,
      height: img ? (img.naturalHeight || img.height) : parseInt(heightMeta && heightMeta.content, 10) || 0 };
    pins.set(id, record);
    if (!selected.has(id)) selected.set(id, selectionMode === "manual" ? manualSelectedPins.has(id) : true);
    setAppearance(record);
  }

  function setAppearance(record) {
    var card = record.card;
    if (!card || !document.contains(card)) return;
    card.classList.add("huaban-dl-card");
    card.classList.toggle("huaban-dl-selected", selected.get(record.id) !== false);
    card.classList.toggle("huaban-dl-deselected", selected.get(record.id) === false);
    var overlay = card.querySelector(":scope > .huaban-dl-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "huaban-dl-overlay";
      card.appendChild(overlay);
    }
    var badge = card.querySelector(":scope > .huaban-dl-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "huaban-dl-badge";
      badge.dataset.pinId = record.id;
      badge.addEventListener("click", function(event) {
        event.preventDefault(); event.stopPropagation();
        var choose = selected.get(record.id) === false;
        selected.set(record.id, choose);
        if (selectionMode === "manual") {
          if (choose) manualSelectedPins.add(record.id); else manualSelectedPins.delete(record.id);
        } else if (choose) manualDeselectedPins.delete(record.id); else manualDeselectedPins.add(record.id);
        if (!choose) removePendingPins([record.id]);
        else restorePendingPins([record.id]);
        setAppearance(record); updateCount();
      });
      card.appendChild(badge);
    }
    syncDetailImageAppearance(record, overlay, badge);
    badge.textContent = selected.get(record.id) === false ? (selectionMode === "manual" ? "" : "\u2717") : "\u2713";
  }

  function syncDetailImageAppearance(record, overlay, badge) {
    var img = record.detailImage;
    var card = record.card;
    if (!img || !card || !img.getBoundingClientRect || !card.getBoundingClientRect) return;
    var imageRect = img.getBoundingClientRect();
    var cardRect = card.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0) return;
    var left = imageRect.left - cardRect.left + (card.scrollLeft || 0);
    var top = imageRect.top - cardRect.top + (card.scrollTop || 0);

    overlay.classList.add("pinterest-dl-detail-image-layer");
    overlay.style.left = left + "px";
    overlay.style.top = top + "px";
    overlay.style.right = "auto";
    overlay.style.bottom = "auto";
    overlay.style.width = imageRect.width + "px";
    overlay.style.height = imageRect.height + "px";
    overlay.style.boxSizing = "border-box";

    badge.classList.add("pinterest-dl-detail-image-badge");
    badge.style.left = Math.max(left, left + imageRect.width - 32) + "px";
    badge.style.top = Math.max(top, top + imageRect.height - 32) + "px";
    badge.style.right = "auto";
    badge.style.bottom = "auto";
  }

  function updateCount() {
    var count = 0;
    selected.forEach(function(value) { if (value) count++; });
    var rejectedCount = 0;
    if (filterEnabled) pins.forEach(function(record) { if (record.promoted) rejectedCount++; });
    var manualCount = selectionMode === "manual" ? Math.max(0, selected.size - count - rejectedCount) : manualDeselectedPins.size;
    var signature = [count, selected.size, manualCount, rejectedCount].join(":");
    if (signature === lastSelectionMessage) return;
    lastSelectionMessage = signature;
    safeSend({ action: "SELECTION_COUNT", selected: count, total: selected.size,
      filterStats: { accepted: count, suspicious: 0, rejected: rejectedCount, manualExcluded: manualCount } });
  }

  function scan() {
    if (!pluginEnabled) return;
    scanDetailPin();
    document.querySelectorAll('img[srcset], img[src*="pinimg.com"]').forEach(function(img) {
      var link = pinLinkForImage(img);
      var card = pinCardForImage(img, link);
      if (!card || img.width < 120 || img.height < 120) return;
      if (!link) return;
      var context = img.closest('[data-test-id="pinWrapper"]') || img.closest('div[data-grid-item]') || card;
      // Pin 详情页的推荐瀑布流通常整体位于 Related/相关容器内。
      // 这些卡片与主页 Pin 结构一致，不能按容器名过滤；非 Pin 的相关
      // 搜索词条目本身没有 /pin/ 链接，已会被上面的 !link 条件排除。
      var urls = largestUrl(img);
      if (!/\.pinimg\.com\//.test(urls.original)) return;
      var id = pinIdFor(img, urls.original);
      var title = img.alt || "";
      var promoted = /promoted|推广|赞助/i.test((context.textContent || ""));
      var record = { id: id, url: urls.original, fallbackUrl: urls.fallback, title: title, card: card, promoted: promoted,
        width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
      pins.set(id, record);
      if (!selected.has(id)) selected.set(id, selectionMode === "manual" ? manualSelectedPins.has(id) && !(filterEnabled && promoted) : !(filterEnabled && promoted));
      setAppearance(record);
    });
    updateCount();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  function cleanName(value) {
    return String(value || "Pinterest").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "Pinterest";
  }

  function dateString() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }

  function originalImageName(image) {
    var source = String(image.url || image.fileKey || image.pin_id || "image").split("?")[0].split("#")[0];
    var name = source.substring(source.lastIndexOf("/") + 1);
    try { name = decodeURIComponent(name); } catch (_error) { /* 保留原值 */ }
    name = name.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
    return cleanName(name || image.pin_id || "image");
  }

  async function fetchImage(primary, fallback) {
    var response = await fetch(primary, { credentials: "omit" });
    if (!response.ok && fallback && fallback !== primary) response = await fetch(fallback, { credentials: "omit" });
    if (!response.ok) throw new Error("图片服务器 HTTP " + response.status);
    return response.blob();
  }

  async function visualHash(blob) {
    var bitmap = await createImageBitmap(blob);
    var canvas = new OffscreenCanvas(16, 8);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 16, 8);
    if (bitmap.close) bitmap.close();
    var data = ctx.getImageData(0, 0, 16, 8).data;
    var hash = "";
    for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
      var a = (y * 16 + x) * 4, b = (y * 16 + x + 1) * 4;
      var ga = data[a] + data[a + 1] + data[a + 2], gb = data[b] + data[b + 1] + data[b + 2];
      hash += ga > gb ? "1" : "0";
    }
    return hash;
  }

  async function downloadQueue(images, totalImages, collectionTitle) {
    var files = [], hashes = [], failed = 0, failedIds = [], failureReasons = {}, visualDuplicates = 0;
    for (var i = 0; i < images.length; i++) {
      try {
        var blob = await fetchImage(images[i].url, images[i].fileKey);
        var hash = await visualHash(blob);
        if (HuabanFilter.isVisualDuplicate(hash, hashes, 2)) { visualDuplicates++; continue; }
        hashes.push(hash);
        var ext = /gif/i.test(blob.type) ? ".gif" : /png/i.test(blob.type) ? ".png" : /webp/i.test(blob.type) ? ".webp" : ".jpg";
        files.push({ name: String(files.length + 1).padStart(4, "0") + "-" + dateString() + "-Pinterest-" + originalImageName(images[i]) + ext, blob: blob });
      } catch (error) {
        failed++; failedIds.push(images[i].pin_id);
        var reason = error && error.message ? error.message : "网络或图片解码失败";
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      }
      safeSend({ action: "DL_PROGRESS", current: i + 1, total: totalImages, ok: files.length, fail: failed, batch: 1, totalBatches: 1 });
    }
    if (!files.length) { safeSend({ action: "DL_ERROR", message: "Pinterest 图片下载失败" }); return; }
    var folderName = "审美图-" + dateString() + "-" + files.length + "张", saved = 0;
    for (var f = 0; f < files.length; f++) {
      var blobUrl = URL.createObjectURL(files[f].blob);
      var result = await new Promise(function(resolve) {
        chrome.runtime.sendMessage({ action: "TRIGGER_DOWNLOAD", blobUrl: blobUrl,
          filename: folderName + "/" + files[f].name, saveAs: false }, function(response) { resolve(response || { ok: false }); });
      });
      setTimeout(function(url) { URL.revokeObjectURL(url); }, 60000, blobUrl);
      if (result.ok) saved++; else failed++;
    }
    safeSend({ action: "DL_DONE", ok: saved, fail: failed, failedPinIds: failedIds,
      failureReasons: failureReasons, visualDuplicates: visualDuplicates, batches: 1, filename: folderName });
  }

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action === "UPDATE_PLUGIN_ENABLED") {
      setPluginEnabled(msg.enabled); sendResponse({ ok: true, enabled: pluginEnabled }); return;
    }
    if (msg.action === "DETECT_PAGE") {
      sendResponse({ pageType: pageType(), site: "pinterest", pageTitle: pageTitle() });
      return;
    }
    if (msg.action === "UPDATE_FILTER_SETTINGS") {
      filterEnabled = !!(msg.settings && msg.settings.enabled);
      pins.forEach(function(record, id) {
        if (record.promoted) {
          var choose = filterEnabled ? false : (selectionMode === "manual" ? manualSelectedPins.has(id) : true);
          selected.set(id, choose);
          if (filterEnabled) removePendingPins([id]);
          else restorePendingPins([id]);
        }
        setAppearance(record);
      });
      updateCount(); sendResponse({ ok: true }); return;
    }
    if (msg.action === "UPDATE_SELECTION_MODE") {
      setSelectionMode(msg.mode); sendResponse({ ok: true, mode: selectionMode }); return;
    }
    if (msg.action === "COLLECT") {
      if (!pluginEnabled) { safeSend({ action: "ERROR", message: "插件已关闭" }); sendResponse({ started: false }); return; }
      var output = [];
      pins.forEach(function(record, id) {
        if (selected.get(id) === false) return;
        output.push({ pin_id: "pinterest:" + id, url: record.url, fileKey: record.fallbackUrl, fileType: "image/jpeg",
          width: record.width, height: record.height, text: record.title });
      });
      if (!output.length) { safeSend({ action: "ERROR", message: "没有选中可采集的 Pin" }); sendResponse({ started: false }); return; }
      safeSend({ action: "COLLECT_START", total: output.length });
      chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: {
        boardId: "pinterest_" + pageTitle(), boardTitle: "Pinterest: " + pageTitle(), creator: "Pinterest", sourceUrl: location.href
      }, pins: output }, function(result) {
        removePendingPins(Array.from(manualDeselectedPins));
        safeSend({ action: "COLLECT_DONE", ok: output.length, fail: 0,
          added: result ? result.added : output.length, skipped: result ? result.skipped : 0 });
      });
      sendResponse({ started: true }); return true;
    }
    if (msg.action === "DO_DOWNLOAD") {
      downloadQueue(msg.images || [], msg.totalImages || 0, msg.collectionTitle || pageTitle());
      sendResponse({ started: true }); return true;
    }
    if (msg.action === "ABORT") { sendResponse({ ok: true }); return; }
  });

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
  window.addEventListener("resize", scheduleScan, { passive: true });
  document.addEventListener("load", function(event) {
    if (event.target && event.target.tagName === "IMG") scheduleScan();
  }, true);
  scan();
  safeSend({ action: "PAGE_TYPE", pageType: pageType(), site: "pinterest" });
})();
