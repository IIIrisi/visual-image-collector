(function() {
  "use strict";

  var works = new Map();
  var selected = new Map();
  var scanTimer = null;
  var observer = null;
  var positionFrame = 0;
  var completeCatalog = new Map();
  var catalogByUrl = new Map();
  var catalogPromise = null;
  var catalogWorkId = "";
  var pluginEnabled = true;
  var lastSelectionMessage = "";
  var selectionMode = "auto";
  var manualSelected = new Set();
  var settingsReady = false;

  function setPluginEnabled(enabled) {
    pluginEnabled = enabled !== false;
    document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
    if (pluginEnabled) { scan(); ensureCompleteCatalog().catch(function() {}); }
  }
  function setSelectionMode(mode) {
    selectionMode = mode === "manual" ? "manual" : "auto";
    document.documentElement.classList.toggle("huaban-dl-manual-mode", selectionMode === "manual");
    selected.forEach(function(_value, id) { selected.set(id, selectionMode === "manual" ? manualSelected.has(id) : true); });
    works.forEach(decorate);
    lastSelectionMessage = ""; updateCount();
  }

  function safeSend(message) {
    try { chrome.runtime.sendMessage(message); } catch (_error) {}
  }

  function pageType() {
    if (/\/work\/[^/]+\.html/i.test(location.pathname)) return "work";
    if (/\/collection\//i.test(location.pathname)) return "collection";
    if (/\/search\//i.test(location.pathname)) return "search";
    return "home";
  }

  function pageTitle() {
    var query = new URLSearchParams(location.search).get("word");
    if (query) return query;
    var heading = document.querySelector("h1");
    return (heading && heading.textContent || document.title || "站酷").replace(/[_-]站酷.*$/i, "").trim();
  }

  function workId(url) {
    var match = String(url || "").match(/\/work\/([^/?#]+)\.html/i);
    return match ? match[1] : "";
  }

  function absoluteImageUrl(img) {
    var srcset = img.getAttribute("srcset") || "";
    var candidates = srcset.split(",").map(function(part) {
      var bits = part.trim().split(/\s+/);
      return { url: bits[0], width: parseInt(bits[1], 10) || 0 };
    }).filter(function(item) { return /^https?:\/\//.test(item.url); });
    candidates.sort(function(a, b) { return b.width - a.width; });
    return candidates.length ? candidates[0].url : (img.currentSrc || img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-actualsrc") || img.src || "");
  }

  function canonicalMediaUrl(value) {
    try {
      var parsed = new URL(String(value || ""), location.href);
      parsed.search = ""; parsed.hash = "";
      parsed.pathname = parsed.pathname.replace(/(\.(?:jpe?g|png|gif|webp))(?:@.*)$/i, "$1");
      return parsed.href;
    } catch (_error) { return String(value || "").split(/[?#]/)[0]; }
  }

  function imageId(img, url, index) {
    var alt = img.getAttribute("alt") || "";
    var match = alt.match(/[（(]图([^）)]+)[）)]/);
    if (match) return match[1];
    var path = String(url).split("?")[0];
    var base = path.substring(path.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
    return base || String(index + 1);
  }

  function isBodyImage(img) {
    var url = absoluteImageUrl(img);
    if (!/^https?:\/\/(?:[^/]+\.)?zcool\.cn\//i.test(url)) return false;
    var alt = img.getAttribute("alt") || "";
    if (/[（(]图[^）)]+[）)]/.test(alt)) return true;
    // 完整作品目录加载后，也允许用已确认的正文 URL 匹配懒加载节点。
    return catalogByUrl.has(canonicalMediaUrl(url));
  }

  function videoUrl(video) {
    var source = video.querySelector("source");
    var values = [video.currentSrc, video.src, video.getAttribute("data-src"), video.getAttribute("data-video-src"),
      source && source.src, source && source.getAttribute("data-src")];
    for (var i = 0; i < values.length; i++) if (/^https?:\/\//i.test(String(values[i] || ""))) return values[i];
    return "";
  }

  function bodyImages(doc, id) {
    var output = [], seen = new Set();
    Array.from(doc.querySelectorAll("img")).forEach(function(img, index) {
      if (!isBodyImage(img)) return;
      var url = absoluteImageUrl(img);
      var canonicalUrl = canonicalMediaUrl(url);
      if (!url || seen.has(canonicalUrl)) return;
      seen.add(canonicalUrl);
      var iid = imageId(img, url, index);
      output.push({
        pin_id: "zcool:" + id + ":" + iid,
        url: url,
        fileKey: url,
        fileType: /\.gif(?:\?|$)/i.test(url) ? "image/gif" : /\.png(?:\?|$)/i.test(url) ? "image/png" : "image/jpeg",
        width: img.naturalWidth || parseInt(img.getAttribute("width"), 10) || 0,
        height: img.naturalHeight || parseInt(img.getAttribute("height"), 10) || 0,
        text: img.getAttribute("alt") || pageTitle(),
        exportName: pageTitle()
      });
    });
    return output;
  }

  function objectPositionOffset(token, freeSpace, axis) {
    token = String(token || "50%").toLowerCase();
    if (token === "center") return freeSpace / 2;
    if (token === (axis === "x" ? "left" : "top")) return 0;
    if (token === (axis === "x" ? "right" : "bottom")) return freeSpace;
    if (/%$/.test(token)) return freeSpace * (parseFloat(token) || 0) / 100;
    if (/px$/.test(token)) return parseFloat(token) || 0;
    return freeSpace / 2;
  }

  // <img>/<video> 的 CSS 盒子不一定等于真正绘制的媒体区域。
  // 对 contain/scale-down 按原始宽高比和 object-position 收紧边界，避免选框包住留白。
  function renderedMediaRect(element) {
    var box = element.getBoundingClientRect();
    var sourceWidth = element.naturalWidth || element.videoWidth || 0;
    var sourceHeight = element.naturalHeight || element.videoHeight || 0;
    if (!sourceWidth || !sourceHeight || !box.width || !box.height) return box;
    var style = getComputedStyle(element);
    var fit = style.objectFit || "fill";
    if (fit !== "contain" && fit !== "scale-down" && fit !== "none") return box;
    var scale = fit === "none" ? 1 : Math.min(box.width / sourceWidth, box.height / sourceHeight);
    if (fit === "scale-down") scale = Math.min(1, scale);
    var width = sourceWidth * scale, height = sourceHeight * scale;
    var parts = String(style.objectPosition || "50% 50%").trim().split(/\s+/);
    var xToken = parts[0] || "50%", yToken = parts[1] || "50%";
    if (/^(top|bottom)$/.test(xToken)) { yToken = xToken; xToken = "50%"; }
    return {
      left: box.left + objectPositionOffset(xToken, box.width - width, "x"),
      top: box.top + objectPositionOffset(yToken, box.height - height, "y"),
      width: width, height: height,
      right: box.left + objectPositionOffset(xToken, box.width - width, "x") + width,
      bottom: box.top + objectPositionOffset(yToken, box.height - height, "y") + height
    };
  }

  function previewIsOpen() {
    if (document.fullscreenElement) return true;
    var candidates = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="lightbox" i], [class*="viewer" i], [class*="preview" i], [class*="modal" i]');
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      if (node.classList.contains("zcool-dl-image-layer")) continue;
      var rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 &&
          rect.width > innerWidth * 0.35 && rect.height > innerHeight * 0.35 && node.querySelector("img, video")) return true;
    }
    return false;
  }

  function bodyVideos(doc, id) {
    var output = [], seen = new Set();
    Array.from(doc.querySelectorAll("video")).forEach(function(video, index) {
      var url = videoUrl(video);
      if (!url || seen.has(url)) return;
      seen.add(url);
      var path = url.split("?")[0], base = path.substring(path.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "") || "video_" + (index + 1);
      var source = video.querySelector("source");
      output.push({
        pin_id: "zcool:" + id + ":video:" + base,
        url: url, fileKey: url,
        fileType: (source && source.type) || video.getAttribute("type") || (/\.webm(?:\?|$)/i.test(url) ? "video/webm" : "video/mp4"),
        width: video.videoWidth || 0, height: video.videoHeight || 0,
        text: pageTitle() + "-视频", mediaType: "video", element: video
      });
    });
    return output;
  }

  function coverFor(img, anchor) {
    var imageRect = img.getBoundingClientRect();
    var node = img.parentElement, best = null;
    for (var i = 0; node && i < 5; i++, node = node.parentElement) {
      var rect = node.getBoundingClientRect();
      var ratio = rect.height > 0 ? rect.width / rect.height : 0;
      var sameOrigin = Math.abs(rect.left - imageRect.left) < 5 && Math.abs(rect.top - imageRect.top) < 5;
      if (sameOrigin && ratio >= 1.20 && ratio <= 1.48 && rect.width >= 140) {
        best = node;
        break;
      }
      if (node === anchor) break;
    }
    return best || img.parentElement || anchor;
  }

  function workCardFor(anchor, cover) {
    var node = anchor, coverWidth = cover.getBoundingClientRect().width;
    for (var i = 0; node && i < 5; i++, node = node.parentElement) {
      var rect = node.getBoundingClientRect();
      if (rect.width >= coverWidth - 8 && rect.width <= coverWidth + 30 && rect.height > cover.getBoundingClientRect().height) return node;
    }
    return anchor;
  }

  function hasMediumOrLargeFire(root, cover) {
    if (!root) return false;
    var levelNode = root.querySelector('[data-recommend-level], [recommendlevel], [data-level*="recommend"]');
    if (levelNode) {
      var level = parseInt(levelNode.getAttribute("data-recommend-level") || levelNode.getAttribute("recommendlevel") || levelNode.getAttribute("data-level"), 10);
      if (level >= 2) return true;
    }
    var text = (root.textContent || "") + " " + (root.getAttribute("title") || "") + " " + (root.getAttribute("aria-label") || "");
    if (/首页推荐|频道推荐|编辑推荐|三火|二火|大火|中火/.test(text)) return true;
    function warmFireColor(value) {
      var source = String(value || "").toLowerCase();
      var rgb = source.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (rgb) return Number(rgb[1]) >= 225 && Number(rgb[2]) >= 30 && Number(rgb[2]) <= 175 && Number(rgb[3]) <= 110;
      var hex = source.match(/#([0-9a-f]{6})\b/);
      if (hex) {
        var r = parseInt(hex[1].slice(0, 2), 16), g = parseInt(hex[1].slice(2, 4), 16), b = parseInt(hex[1].slice(4, 6), 16);
        return r >= 225 && g >= 30 && g <= 175 && b <= 110;
      }
      return false;
    }
    function looksLikeFlame(element) {
      if (!element) return false;
      var markup = (element.outerHTML || "").slice(0, 2500);
      var semantic = ((element.className && (element.className.baseVal || element.className)) || "") + " " +
        (element.getAttribute("title") || "") + " " + (element.getAttribute("aria-label") || "") + " " +
        (element.getAttribute("src") || "") + " " + (element.getAttribute("data-icon") || "");
      if (/fire|flame|hot|recommend|火焰|火苗/i.test(semantic + " " + markup)) return true;
      // 火焰 SVG 通常包含多个收尖的闭合 path；排除圆形播放/点赞图标。
      if (element.tagName && element.tagName.toLowerCase() === "svg") {
        var paths = element.querySelectorAll("path");
        var circles = element.querySelectorAll("circle, polygon[points]");
        var pathData = Array.from(paths).map(function(path) { return path.getAttribute("d") || ""; }).join(" ");
        return paths.length >= 1 && circles.length <= 1 && pathData.length >= 45 && /[cq].*[cq]/i.test(pathData);
      }
      return false;
    }
    var candidates = root.querySelectorAll('[class*="fire" i], [class*="flame" i], [class*="recommend" i], [class*="level" i], [title*="推荐"], [aria-label*="推荐"], img[src*="fire" i], img[src*="flame" i], img[src*="recommend" i], svg');
    for (var i = 0; i < candidates.length; i++) {
      var element = candidates[i];
      var rect = element.getBoundingClientRect();
      if (rect.width < 10 || rect.width > 48 || rect.height < 10 || rect.height > 48) continue;
      var signature = ((element.className && (element.className.baseVal || element.className)) || "") + " " +
        (element.getAttribute("title") || "") + " " + (element.getAttribute("aria-label") || "") + " " +
        (element.getAttribute("src") || "") + " " + (element.outerHTML || "").slice(0, 500);
      var style = getComputedStyle(element);
      var colorSource = [style.color, style.fill, style.backgroundColor,
        element.getAttribute("fill"), element.getAttribute("color"), element.getAttribute("src")].join(" ");
      // 大火既可能是白色圆底红火，也可能是独立红火；中火是独立橙火。
      // 黄色/灰色的小火不在默认选择范围内。
      var explicitMediumLarge = /(?:level|recommend|fire)[-_]?(?:2|3|medium|large|big)|二火|三火|中火|大火/i.test(signature);
      var redOrOrange = warmFireColor(colorSource);
      if (looksLikeFlame(element) && (explicitMediumLarge || redOrOrange)) return true;
    }
    // 新版站酷部分火标使用父元素背景图/伪元素，且中火也可能带白色圆底。
    // 仅检查封面右下角的小型节点，避免把播放、点赞等卡片外图标误判成火。
    if (cover) {
      var coverRect = cover.getBoundingClientRect();
      var cornerNodes = cover.querySelectorAll("*");
      for (var j = 0; j < cornerNodes.length; j++) {
        var node = cornerNodes[j], rect = node.getBoundingClientRect();
        if (rect.width < 8 || rect.width > 46 || rect.height < 8 || rect.height > 46) continue;
        if (rect.right < coverRect.right - 75 || rect.bottom < coverRect.bottom - 75) continue;
        var nodeText = (node.getAttribute("title") || "") + " " + (node.getAttribute("aria-label") || "") + " " +
          ((node.className && (node.className.baseVal || node.className)) || "");
        var nodeStyle = getComputedStyle(node), beforeStyle = getComputedStyle(node, "::before"), afterStyle = getComputedStyle(node, "::after");
        var visual = [nodeStyle.color, nodeStyle.fill, nodeStyle.backgroundColor, nodeStyle.backgroundImage,
          beforeStyle.color, beforeStyle.backgroundColor, beforeStyle.backgroundImage, beforeStyle.content,
          afterStyle.color, afterStyle.backgroundColor, afterStyle.backgroundImage, afterStyle.content,
          node.getAttribute("style"), node.outerHTML.slice(0, 500)].join(" ");
        var fireSemantic = looksLikeFlame(node) || /fire|flame|火焰|火苗/i.test(nodeText + " " + visual);
        var hasWarmColor = warmFireColor(visual);
        var hasRoundWhiteBase = /rgb\(255,\s*255,\s*255\)|rgba\(255,\s*255,\s*255/i.test(visual) && rect.width >= 20;
        if (fireSemantic && (hasWarmColor || hasRoundWhiteBase)) return true;
      }
    }
    return false;
  }

  function directCollectorChild(host, className, recordId) {
    return Array.from(host.children || []).find(function(node) {
      return node.classList && node.classList.contains(className) && node.dataset && node.dataset.zcoolId === recordId;
    }) || null;
  }

  function decorateElement(record, img) {
    if (!img || !document.contains(img)) return;
    var host = img.parentElement;
    if (!host) return;
    host.dataset.zcoolMedia = record.id;
    var overlay = directCollectorChild(host, "zcool-dl-image-layer", record.id);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "huaban-dl-overlay zcool-dl-image-layer";
      host.appendChild(overlay);
    }
    overlay.dataset.zcoolId = record.id;
    host.classList.add("huaban-dl-card", "zcool-dl-overlay-host");
    var isSelected = selected.get(record.id) !== false;
    host.classList.toggle("huaban-dl-selected", isSelected);
    host.classList.toggle("huaban-dl-deselected", !isSelected);
    overlay.classList.toggle("zcool-dl-selected", isSelected);
    overlay.classList.toggle("zcool-dl-deselected", !isSelected);
    var rect = renderedMediaRect(img);
    var hostRect = host.getBoundingClientRect();
    overlay.style.left = rect.left - hostRect.left + host.scrollLeft + "px";
    overlay.style.top = rect.top - hostRect.top + host.scrollTop + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    // 选框属于媒体容器自身，不需要按当前视口做显示/隐藏。
    // 若在视口外先设为 none，滚动本身又不会触发扫描，就会出现滚动期间选框消失、
    // 等站酷懒加载或 DOM 更新后才重新显示的问题。让浏览器随宿主自然滚动即可。
    overlay.style.display = "block";
    var badge = directCollectorChild(host, "huaban-dl-badge", record.id);
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "huaban-dl-badge";
      host.appendChild(badge);
    }
    badge.dataset.zcoolId = record.id;
    badge.classList.add("zcool-dl-badge");
    badge.classList.toggle("zcool-dl-selected", isSelected);
    badge.classList.toggle("zcool-dl-deselected", !isSelected);
    if (badge.dataset.zcoolBound !== "1") badge.onclick = function(event) {
        event.preventDefault(); event.stopPropagation();
        var currentId = badge.dataset.zcoolId;
        var currentRecord = works.get(currentId);
        if (!currentRecord) return;
        var choose = selected.get(currentId) === false;
        selected.set(currentId, choose);
        if (selectionMode === "manual") {
          if (choose) manualSelected.add(currentId); else manualSelected.delete(currentId);
        }
        decorate(currentRecord); updateCount();
      };
    badge.dataset.zcoolBound = "1";
    badge.style.left = rect.right - hostRect.left + host.scrollLeft - 32 + "px";
    badge.style.top = rect.bottom - hostRect.top + host.scrollTop - 32 + "px";
    badge.style.right = "auto";
    badge.style.bottom = "auto";
    badge.style.display = "flex";
    var badgeText = isSelected ? "✓" : (selectionMode === "manual" ? "" : "✗");
    if (badge.textContent !== badgeText) badge.textContent = badgeText;
  }

  function decorate(record) {
    var elements = record.elements ? Array.from(record.elements) : [record.img];
    elements.forEach(function(element) { decorateElement(record, element); });
  }

  function syncAllLayers() {
    positionFrame = 0;
    works.forEach(decorate);
  }

  function schedulePositionSync() {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(syncAllLayers);
  }

  function updateCount() {
    var count = 0;
    selected.forEach(function(value) { if (value) count++; });
    var manualCount = selected.size - count;
    var signature = [count, selected.size, manualCount].join(":");
    if (signature === lastSelectionMessage) return;
    lastSelectionMessage = signature;
    safeSend({ action: "SELECTION_COUNT", selected: count, total: selected.size,
      itemLabel: pageType() === "work" ? "张图片" : "个作品",
      filterStats: { accepted: count, suspicious: 0, rejected: 0, manualExcluded: manualCount } });
  }

  function scanList() {
    document.querySelectorAll('a[href*="/work/"][href*=".html"]').forEach(function(anchor) {
      var id = workId(anchor.href);
      var img = anchor.querySelector("img") || (anchor.parentElement && anchor.parentElement.querySelector("img"));
      if (!id || !img || img.width < 100 || img.height < 80) return;
      var card = coverFor(img, anchor);
      var root = workCardFor(anchor, card);
      var promoted = /推广|广告|赞助/.test(root.textContent || "");
      var recommended = hasMediumOrLargeFire(root, card);
      var record = { id: id, url: anchor.href, title: img.alt || (root.textContent || "").trim().slice(0, 80), card: card, img: img, root: root, promoted: promoted, recommended: recommended };
      works.set(id, record);
      if (!selected.has(id)) selected.set(id, selectionMode === "manual" ? manualSelected.has(id) : !promoted && recommended);
      decorate(record);
    });
  }

  function scanWork() {
    var id = workId(location.href), activeElements = new Set(), activeIds = new Set();
    works.forEach(function(record) { record.elements = new Set(); });
    Array.from(document.querySelectorAll("img")).filter(isBodyImage).forEach(function(img, index) {
      var url = absoluteImageUrl(img), canonicalUrl = canonicalMediaUrl(url);
      var image = catalogByUrl.get(canonicalUrl);
      if (!image) {
        var iid = imageId(img, url, index);
        image = completeCatalog.get("zcool:" + id + ":" + iid) || {
          pin_id: "zcool:" + id + ":" + iid, url: url, fileKey: url,
          fileType: /\.gif(?:\?|$)/i.test(url) ? "image/gif" : /\.png(?:\?|$)/i.test(url) ? "image/png" : "image/jpeg",
          width: img.naturalWidth || 0, height: img.naturalHeight || 0,
          text: img.getAttribute("alt") || pageTitle(), exportName: pageTitle()
        };
        catalogByUrl.set(canonicalUrl, image);
      }
      var record = works.get(image.pin_id);
      if (!record) record = { id: image.pin_id, image: image, elements: new Set() };
      record.image = image; record.elements.add(img); record.img = img;
      works.set(record.id, record); activeIds.add(record.id); activeElements.add(img);
      if (!selected.has(record.id)) selected.set(record.id, selectionMode === "manual" ? manualSelected.has(record.id) : true);
    });
    bodyVideos(document, id).forEach(function(video) {
      var element = video.element;
      delete video.element;
      var record = works.get(video.pin_id) || { id: video.pin_id, image: video, elements: new Set() };
      record.image = video; record.elements.add(element); record.img = element;
      works.set(record.id, record);
      activeIds.add(record.id); activeElements.add(element);
      if (!selected.has(record.id)) selected.set(record.id, selectionMode === "manual" ? manualSelected.has(record.id) : true);
    });
    Array.from(works.keys()).forEach(function(recordId) { if (!activeIds.has(recordId)) works.delete(recordId); });
    works.forEach(decorate);
    document.querySelectorAll("[data-zcool-media]").forEach(function(host) {
      host.querySelectorAll(":scope > .zcool-dl-image-layer, :scope > .huaban-dl-badge[data-zcool-id]").forEach(function(node) {
        if (!activeIds.has(String(node.dataset.zcoolId || ""))) node.remove();
      });
      var hasActiveMedia = Array.from(host.querySelectorAll("img, video")).some(function(mediaElement) {
        return activeElements.has(mediaElement);
      });
      if (hasActiveMedia) return;
      host.querySelectorAll(":scope > .zcool-dl-image-layer, :scope > .huaban-dl-badge[data-zcool-id]").forEach(function(node) { node.remove(); });
      host.classList.remove("huaban-dl-card", "zcool-dl-overlay-host", "huaban-dl-selected", "huaban-dl-deselected");
      delete host.dataset.zcoolMedia;
    });
  }

  function scan() {
    if (!pluginEnabled || !settingsReady) return;
    // 站酷列表页不再做默认选择：用户进入作品详情后再采集整件作品。
    if (pageType() === "work") scanWork();
    else {
      works.clear();
      selected.clear();
      document.querySelectorAll(".zcool-dl-image-layer").forEach(function(layer) { layer.remove(); });
    }
    updateCount();
  }

  function scheduleScan() {
    // 固定短节流：连续滚动/懒加载也保证扫描会执行，不再等页面“完全安静”。
    if (scanTimer) return;
    scanTimer = setTimeout(function() { scanTimer = null; scan(); }, 50);
    schedulePositionSync();
  }

  async function fetchCompleteWork() {
    var response = await fetch(location.href, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error("作品页 HTTP " + response.status);
    var html = await response.text();
    var doc = new DOMParser().parseFromString(html, "text/html");
    return bodyImages(doc, workId(location.href));
  }

  function ensureCompleteCatalog() {
    var id = workId(location.href);
    if (!id) return Promise.resolve([]);
    if (catalogWorkId === id && completeCatalog.size) return Promise.resolve(Array.from(completeCatalog.values()));
    if (catalogPromise && catalogWorkId === id) return catalogPromise;
    catalogWorkId = id;
    completeCatalog.clear();
    catalogByUrl.clear();
    catalogPromise = fetchCompleteWork().then(function(images) {
      images.forEach(function(image) {
        completeCatalog.set(image.pin_id, image);
        catalogByUrl.set(canonicalMediaUrl(image.url), image);
        if (!selected.has(image.pin_id)) selected.set(image.pin_id, selectionMode === "manual" ? manualSelected.has(image.pin_id) : true);
      });
      updateCount();
      scheduleScan();
      return images;
    }).catch(function(error) {
      catalogPromise = null;
      throw error;
    });
    return catalogPromise;
  }

  async function collect() {
    if (pageType() !== "work") {
      safeSend({ action: "ERROR", message: "请先进入站酷作品详情页，再采集整件作品" });
      return;
    }
    try { await ensureCompleteCatalog(); } catch (_catalogError) { /* 失败时仍可采集已渲染图片 */ }
    safeSend({ action: "COLLECT_START", total: selected.size });
    var output = [], failed = 0, seen = new Set();
    completeCatalog.forEach(function(image, id) {
      if (selected.get(id) !== false && !seen.has(image.url)) { seen.add(image.url); output.push(image); }
    });
    works.forEach(function(record, id) {
      if (selected.get(id) === false) return;
      if (record.image && !seen.has(record.image.url)) { seen.add(record.image.url); output.push(record.image); }
    });
    if (!output.length) {
      var hasKnownMedia = selected.size > 0 || completeCatalog.size > 0 || works.size > 0;
      if (hasKnownMedia) safeSend({ action: "WORK_SELECTION_EMPTY", message: "本作品已取消选择；如需采集，请先重新选中" });
      else safeSend({ action: "ERROR", message: "未找到作品正文图片或视频，请刷新页面后重试" });
      return;
    }
    chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: {
      boardId: "zcool_" + pageTitle(), boardTitle: "站酷: " + pageTitle(), creator: "站酷", sourceUrl: location.href
    }, pins: output }, function(result) {
      safeSend({ action: "COLLECT_DONE", ok: output.length, fail: failed,
        added: result ? result.added : output.length, skipped: result ? result.skipped : 0 });
    });
  }

  chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
    if (msg.action === "UPDATE_PLUGIN_ENABLED") {
      setPluginEnabled(msg.enabled); sendResponse({ ok: true, enabled: pluginEnabled }); return;
    }
    if (msg.action === "SET_WORK_SELECTION") {
      var choose = msg.selected !== false;
      selected.forEach(function(_value, id) { selected.set(id, choose); });
      completeCatalog.forEach(function(_image, id) { selected.set(id, choose); });
      if (selectionMode === "manual") selected.forEach(function(_value, id) { if (choose) manualSelected.add(id); else manualSelected.delete(id); });
      works.forEach(function(record, id) { selected.set(id, choose); decorate(record); });
      lastSelectionMessage = ""; updateCount();
      sendResponse({ ok: true, selected: choose, total: selected.size, boardId: "zcool_" + pageTitle() }); return;
    }
    if (msg.action === "DETECT_PAGE") {
      sendResponse({ pageType: pageType(), site: "zcool", pageTitle: pageTitle() }); return;
    }
    if (msg.action === "COLLECT") {
      if (!pluginEnabled) { safeSend({ action: "ERROR", message: "插件已关闭" }); sendResponse({ started: false }); return; }
      collect(); sendResponse({ started: true }); return true;
    }
    if (msg.action === "UPDATE_FILTER_SETTINGS") { sendResponse({ ok: true }); return; }
    if (msg.action === "UPDATE_SELECTION_MODE") { setSelectionMode(msg.mode); sendResponse({ ok: true, mode: selectionMode }); return; }
    if (msg.action === "ABORT") { sendResponse({ ok: true }); return; }
  });

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "srcset", "data-src", "data-original", "data-actualsrc", "data-video-src"]
  });
  // 懒加载节点常常早已在 DOM 中，只在真实媒体完成加载时才可计算边界。
  document.addEventListener("load", function(event) {
    if (event.target && /^(IMG|VIDEO)$/.test(event.target.tagName || "")) scheduleScan();
  }, true);
  // 选框已绑定在媒体容器内：滚动期间不再用 JS 追踪坐标，避免一帧延迟造成“飞框”。
  window.addEventListener("resize", schedulePositionSync, { passive: true });
  document.addEventListener("fullscreenchange", schedulePositionSync);
  // 站酷预览器可能只改 class/style 而不增删节点。
  document.addEventListener("click", function() {
    requestAnimationFrame(schedulePositionSync);
    setTimeout(schedulePositionSync, 120);
  }, true);
  chrome.storage.local.get(["aesthetic_collector_enabled", "aesthetic_selection_mode"], function(data) {
    pluginEnabled = data.aesthetic_collector_enabled !== false;
    selectionMode = data.aesthetic_selection_mode === "manual" ? "manual" : "auto";
    settingsReady = true;
    document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
    document.documentElement.classList.toggle("huaban-dl-manual-mode", selectionMode === "manual");
    scan();
    if (pageType() === "work") ensureCompleteCatalog().catch(function() {});
    safeSend({ action: "PAGE_TYPE", pageType: pageType(), site: "zcool" });
  });
})();
