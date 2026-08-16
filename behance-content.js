(function() {
  "use strict";

  var records = new Map();
  var selected = new Map();
  var completeCatalog = new Map();
  var scanTimer = null;
  var pluginEnabled = true;
  var lastSelectionMessage = "";
  var catalogProjectId = "";

  function safeSend(message) {
    try { chrome.runtime.sendMessage(message); } catch (_error) {}
  }

  function pageType() {
    return /\/gallery\/\d+\//i.test(location.pathname) ? "project" : "other";
  }

  function projectId() {
    var match = location.pathname.match(/\/gallery\/(\d+)\//i);
    return match ? match[1] : "";
  }

  function meta(property) {
    var node = document.querySelector('meta[property="' + property + '"]');
    return node && node.content || "";
  }

  function projectTitle() {
    var heading = document.querySelector("h1");
    return String(heading && heading.textContent || meta("og:title") || document.title || "Behance 项目")
      .replace(/\s*::\s*Behance.*$/i, "").trim();
  }

  function projectOwner() {
    return meta("og:owners") || "Behance";
  }

  function displayedUrl(img) {
    var srcset = img.getAttribute("srcset") || "";
    var candidates = srcset.split(",").map(function(part) {
      var bits = part.trim().split(/\s+/);
      return { url: bits[0], width: parseInt(bits[1], 10) || 0 };
    }).filter(function(item) { return /^https?:\/\//i.test(item.url); });
    candidates.sort(function(a, b) { return b.width - a.width; });
    return candidates.length ? candidates[0].url :
      (img.currentSrc || img.getAttribute("data-src") || img.getAttribute("data-original") || img.src || "");
  }

  function canonicalUrl(value) {
    try {
      var parsed = new URL(String(value || ""), location.href);
      parsed.search = ""; parsed.hash = "";
      return parsed.href;
    } catch (_error) { return String(value || "").split(/[?#]/)[0]; }
  }

  function isProjectModuleUrl(value) {
    return /^https?:\/\/mir-s3-cdn-cf\.behance\.net\/project_modules\//i.test(String(value || ""));
  }

  // BeDownloader 的有效思路：Behance 展示规格可回退到 project_modules/source。
  function sourceImageUrl(value) {
    var url = canonicalUrl(value);
    return isProjectModuleUrl(url) ? url.replace(/\/project_modules\/[^/]+\//i, "/project_modules/source/") : url;
  }

  function fileType(url) {
    return /\.gif(?:[?#]|$)/i.test(url) ? "image/gif" :
      /\.png(?:[?#]|$)/i.test(url) ? "image/png" :
      /\.webp(?:[?#]|$)/i.test(url) ? "image/webp" : "image/jpeg";
  }

  function projectState(doc) {
    var node = doc && doc.querySelector && doc.querySelector("#beconfig-store_state");
    if (!node) return null;
    try {
      var state = JSON.parse(node.textContent || "{}");
      return state && state.project && state.project.project || null;
    } catch (_error) { return null; }
  }

  function gifAsset(module) {
    if (!module || module.__typename !== "ImageModule") return null;
    var sizes = module.imageSizes && Array.isArray(module.imageSizes.allAvailable) ? module.imageSizes.allAvailable : [];
    var candidates = sizes.filter(function(item) {
      return item && (/^gif$/i.test(String(item.type || "")) || /\.gif(?:[?#]|$)/i.test(String(item.url || "")));
    });
    if (/\.gif(?:[?#]|$)/i.test(String(module.src || ""))) {
      candidates.push({ type: "GIF", url: module.src, width: module.width || 0 });
    }
    candidates.sort(function(a, b) {
      var aSource = /\/project_modules\/source\//i.test(String(a.url || "")) ? 1 : 0;
      var bSource = /\/project_modules\/source\//i.test(String(b.url || "")) ? 1 : 0;
      return bSource - aSource || (Number(b.width) || 0) - (Number(a.width) || 0);
    });
    var chosen = candidates[0];
    if (!chosen || !/^https?:\/\//i.test(String(chosen.url || ""))) return null;
    return { moduleId: String(module.id || ""), url: canonicalUrl(chosen.url),
      width: Number(chosen.width) || Number(module.width) || 0, height: Number(module.height) || 0 };
  }

  function gifRecords(doc) {
    var state = projectState(doc), modules = state && Array.isArray(state.allModules) ? state.allModules : [];
    return modules.map(gifAsset).filter(Boolean).map(function(asset) {
      return { id: "behance:" + projectId() + ":gif:" + asset.moduleId, moduleId: asset.moduleId,
        url: asset.url, fallbackUrl: asset.url, fileType: "image/gif", width: asset.width, height: asset.height,
        text: projectTitle(), exportName: projectTitle(), element: null };
    });
  }

  function decodeEmbedHtml(value) {
    var textarea = document.createElement("textarea");
    textarea.innerHTML = String(value || "");
    return textarea.value;
  }

  function vimeoAsset(module) {
    if (!module || module.__typename !== "EmbedModule") return null;
    var html = decodeEmbedHtml(module.originalEmbed || module.fluidEmbed || module.embed || "");
    var match = html.match(/https?:\/\/player\.vimeo\.com\/video\/(\d+)[^\s"'<>]*/i);
    if (!match) return null;
    var playerUrl = match[0].replace(/&amp;/g, "&");
    return { moduleId: String(module.id || match[1]), videoId: match[1], playerUrl: playerUrl,
      width: Number(module.width) || 0, height: Number(module.height) || 0 };
  }

  function vimeoRecords(doc) {
    var state = projectState(doc), modules = state && Array.isArray(state.allModules) ? state.allModules : [];
    return modules.map(vimeoAsset).filter(Boolean).map(function(asset) {
      return { id: "behance:" + projectId() + ":vimeo:" + asset.moduleId, moduleId: asset.moduleId,
        videoId: asset.videoId, url: asset.playerUrl, fallbackUrl: "", fileType: "video/mp4", mediaType: "video",
        isVimeo: true, width: asset.width, height: asset.height,
        text: projectTitle(), exportName: projectTitle(), element: null };
    });
  }

  function moduleIdForImage(img) {
    var link = img && img.closest && img.closest('a[href*="/modules/"]');
    var match = link && String(link.getAttribute("href") || "").match(/\/modules\/(\d+)/i);
    return match ? match[1] : "";
  }

  function recordFromImage(img, index) {
    var fallback = canonicalUrl(displayedUrl(img));
    if (!isProjectModuleUrl(fallback)) return null;
    var original = sourceImageUrl(fallback);
    var base = original.substring(original.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "") || String(index + 1);
    return { id: "behance:" + projectId() + ":" + base, url: original, fallbackUrl: fallback,
      fileType: fileType(original), width: img.naturalWidth || parseInt(img.getAttribute("width"), 10) || 0,
      height: img.naturalHeight || parseInt(img.getAttribute("height"), 10) || 0,
      text: img.getAttribute("alt") || projectTitle(), exportName: projectTitle(), element: img };
  }

  function queueItem(record) {
    return { pin_id: record.id, url: record.url, fileKey: record.fallbackUrl, fileType: record.fileType,
      mediaType: record.mediaType || "image", isVimeo: record.isVimeo === true,
      width: record.width, height: record.height,
      text: record.text, exportName: record.exportName };
  }

  function cleanup() {
    document.querySelectorAll("[data-behance-media]").forEach(function(host) {
      host.querySelectorAll(":scope > .huaban-dl-overlay, :scope > .huaban-dl-badge[data-behance-id]").forEach(function(node) { node.remove(); });
      host.classList.remove("huaban-dl-card", "huaban-dl-selected", "huaban-dl-deselected");
      host.removeAttribute("data-behance-media");
    });
  }

  function decorate(record) {
    var media = record.element;
    if (!media || !media.isConnected) return;
    var host = media.closest("picture") || media.parentElement;
    if (!host) return;
    host.dataset.behanceMedia = record.id;
    host.classList.add("huaban-dl-card");
    var choose = selected.get(record.id) !== false;
    host.classList.toggle("huaban-dl-selected", choose);
    host.classList.toggle("huaban-dl-deselected", !choose);
    var overlay = host.querySelector(":scope > .huaban-dl-overlay");
    if (!overlay) { overlay = document.createElement("div"); overlay.className = "huaban-dl-overlay"; host.appendChild(overlay); }
    var badge = host.querySelector(":scope > .huaban-dl-badge[data-behance-id]");
    if (!badge) {
      badge = document.createElement("div"); badge.className = "huaban-dl-badge";
      badge.dataset.behanceId = record.id; host.appendChild(badge);
    }
    badge.textContent = choose ? "✓" : "✗";
    badge.onclick = function(event) {
      event.preventDefault(); event.stopPropagation();
      selected.set(record.id, selected.get(record.id) === false);
      decorate(record); lastSelectionMessage = ""; updateCount();
    };
  }

  function bodyMedia(doc) {
    var output = [], seen = new Set(), gifByModule = new Map();
    gifRecords(doc).forEach(function(record) { gifByModule.set(record.moduleId, record); });
    Array.from(doc.querySelectorAll("img")).forEach(function(img, index) {
      var moduleId = moduleIdForImage(img), record = gifByModule.get(moduleId) || recordFromImage(img, index);
      if (!record || seen.has(record.url)) return;
      if (record.moduleId) {
        record = Object.assign({}, record, { element: img, fallbackUrl: canonicalUrl(displayedUrl(img)) || record.url,
          text: img.getAttribute("alt") || projectTitle() });
      }
      seen.add(record.url); output.push(record);
    });
    gifByModule.forEach(function(record) {
      if (!seen.has(record.url)) { seen.add(record.url); output.push(record); }
    });
    var iframeByVideo = new Map();
    Array.from(doc.querySelectorAll('iframe[src*="player.vimeo.com/video/"]')).forEach(function(iframe) {
      var match = String(iframe.getAttribute("src") || "").match(/player\.vimeo\.com\/video\/(\d+)/i);
      if (match) iframeByVideo.set(match[1], iframe);
    });
    vimeoRecords(doc).forEach(function(record) {
      record.element = iframeByVideo.get(record.videoId) || null;
      if (!seen.has(record.url)) { seen.add(record.url); output.push(record); }
    });
    return output;
  }

  function scan() {
    if (!pluginEnabled) return;
    if (pageType() !== "project") {
      cleanup(); records.clear(); selected.clear(); completeCatalog.clear(); catalogProjectId = ""; updateCount(); return;
    }
    if (catalogProjectId !== projectId()) {
      cleanup(); records.clear(); selected.clear(); completeCatalog.clear();
      catalogProjectId = projectId(); lastSelectionMessage = "";
    }
    var active = new Set();
    bodyMedia(document).forEach(function(record) {
      active.add(record.id); records.set(record.id, record);
      completeCatalog.set(record.id, record);
      if (!selected.has(record.id)) selected.set(record.id, true);
      decorate(record);
    });
    records.forEach(function(record, id) {
      if (!active.has(id) && (!record.element || !record.element.isConnected)) records.delete(id);
    });
    updateCount();
  }

  async function ensureCompleteCatalog() {
    if (pageType() !== "project") return;
    try {
      var response = await fetch(location.href, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      var doc = new DOMParser().parseFromString(await response.text(), "text/html");
      bodyMedia(doc).forEach(function(record) {
        record.element = null; completeCatalog.set(record.id, record);
        if (!selected.has(record.id)) selected.set(record.id, true);
      });
      lastSelectionMessage = ""; updateCount();
    } catch (_error) { /* 已渲染正文仍可采集 */ }
  }

  function updateCount() {
    var total = completeCatalog.size || records.size, count = 0;
    var source = completeCatalog.size ? completeCatalog : records;
    source.forEach(function(_record, id) { if (selected.get(id) !== false) count++; });
    var signature = count + ":" + total + ":" + projectId();
    if (signature === lastSelectionMessage) return;
    lastSelectionMessage = signature;
    safeSend({ action: "SELECTION_COUNT", selected: count, total: total,
      filterStats: { accepted: count, suspicious: 0, rejected: 0, manualExcluded: total - count } });
  }

  async function collect() {
    if (pageType() !== "project") { safeSend({ action: "ERROR", message: "请进入 Behance 项目详情页后采集" }); return; }
    await ensureCompleteCatalog();
    var source = completeCatalog.size ? completeCatalog : records, output = [];
    source.forEach(function(record, id) { if (selected.get(id) !== false) output.push(queueItem(record)); });
    if (!output.length) { safeSend({ action: "ERROR", message: "未找到 Behance 项目正文媒体" }); return; }
    safeSend({ action: "COLLECT_START", total: output.length });
    chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: {
      boardId: "behance_" + projectId(), boardTitle: "Behance: " + projectTitle(),
      creator: projectOwner(), sourceUrl: location.href
    }, pins: output }, function(result) {
      safeSend({ action: "COLLECT_DONE", ok: output.length, fail: 0,
        added: result ? result.added : output.length, skipped: result ? result.skipped : 0 });
    });
  }

  chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
    if (msg.action === "UPDATE_PLUGIN_ENABLED") {
      pluginEnabled = msg.enabled !== false;
      document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
      if (pluginEnabled) scan(); else cleanup();
      sendResponse({ ok: true, enabled: pluginEnabled }); return;
    }
    if (msg.action === "DETECT_PAGE") {
      var total = completeCatalog.size || records.size, count = 0;
      (completeCatalog.size ? completeCatalog : records).forEach(function(_record, id) { if (selected.get(id) !== false) count++; });
      sendResponse({ pageType: pageType(), site: "behance", pageTitle: projectTitle(), selected: count, total: total }); return;
    }
    if (msg.action === "SET_WORK_SELECTION") {
      var choose = msg.selected !== false;
      selected.forEach(function(_value, id) { selected.set(id, choose); });
      records.forEach(decorate); lastSelectionMessage = ""; updateCount();
      sendResponse({ ok: true, selected: choose, total: selected.size, boardId: "behance_" + projectId() }); return;
    }
    if (msg.action === "COLLECT") {
      if (!pluginEnabled) { safeSend({ action: "ERROR", message: "插件已关闭" }); sendResponse({ started: false }); return; }
      collect(); sendResponse({ started: true }); return true;
    }
    if (msg.action === "UPDATE_FILTER_SETTINGS" || msg.action === "ABORT") { sendResponse({ ok: true }); return; }
  });

  chrome.storage.local.get(["aesthetic_collector_enabled"], function(data) {
    pluginEnabled = data.aesthetic_collector_enabled !== false;
    document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
    scan(); ensureCompleteCatalog();
  });
  new MutationObserver(function() {
    if (scanTimer) return;
    scanTimer = setTimeout(function() { scanTimer = null; scan(); }, 80);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "srcset", "data-src", "class"] });
  document.addEventListener("load", function(event) { if (event.target && event.target.tagName === "IMG") scan(); }, true);
  safeSend({ action: "PAGE_TYPE", pageType: pageType(), site: "behance" });
})();
