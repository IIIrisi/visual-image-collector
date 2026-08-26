(function() {
  "use strict";

  var media = new Map();
  var selected = new Map();
  var note = { noteId: "", title: "小红书笔记", author: "", images: [], videos: [], isVideo: false };
  var pluginEnabled = true;
  var scanTimer = null;
  var lastSelectionMessage = "";
  var lastNotePayload = "";
  var removedPendingMedia = new Set();
  var activeXhsElement = null;
  var activeXhsOutlineElement = null;
  var activeXhsUsesFixedOutline = false;
  var activeXhsRecord = null;
  var activeXhsSelected = null;
  var activeXhsBox = null;
  var activeXhsStableFrames = 0;
  var activeXhsMotionStable = false;
  var activeXhsLiveFrame = null;
  var activeXhsLiveHostBox = null;
  var livePageScrolling = false;
  var liveScrollTimer = null;
  var lastLiveSlideIndex = 0;
  var lastLiveSlideNoteId = "";
  var selectionMode = "auto";
  var manualSelected = new Set();
  var liveRecordByHost = new WeakMap();
  var liveHostSelector = '.live-photo-contain, [class*="live-photo" i], [class*="livephoto" i], [class*="motion-photo" i]';

  function safeSend(message) {
    try { chrome.runtime.sendMessage(message, function() { if (chrome.runtime.lastError) { /* ignore */ } }); } catch (_error) {}
  }

  function pageType() {
    return /\/(?:explore|discovery\/item)\/[a-z0-9]+/i.test(location.pathname) ? "note" : "home";
  }

  function noteId() {
    var match = location.pathname.match(/\/(?:explore|discovery\/item)\/([a-z0-9]+)/i);
    return match ? match[1] : "";
  }

  function boardId() { return "xiaohongshu_" + (note.noteId || noteId()); }

  function queueBoardInfo() {
    return { boardId: boardId(), boardTitle: "小红书: " + note.title, creator: note.author, sourceUrl: location.href };
  }

  function queueItem(record) {
    return { pin_id: record.id, url: record.url, fileKey: "", fileType: record.fileType,
      mediaType: record.mediaType, backupUrls: record.backupUrls || [], isLiveVideo: record.isLiveVideo === true, width: record.width || 0, height: record.height || 0,
      text: note.title, exportName: note.title };
  }

  function removePending(record) {
    chrome.runtime.sendMessage({ action: "REMOVE_FILTERED_IMAGES", pinIds: [record.id] }, function(result) {
      if (chrome.runtime.lastError || !result || !result.removed) return;
      removedPendingMedia.add(record.id);
      safeSend({ action: "PENDING_QUEUE_CHANGED", removed: result.removed });
      if (selected.get(record.id) === true) restorePending(record);
    });
  }

  function restorePending(record) {
    if (!record || !removedPendingMedia.has(record.id)) return;
    chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: queueBoardInfo(), pins: [queueItem(record)] }, function(result) {
      if (chrome.runtime.lastError || !result) return;
      removedPendingMedia.delete(record.id);
      safeSend({ action: "PENDING_QUEUE_CHANGED", restored: result.added || 0 });
    });
  }

  function cleanTitle(value) {
    return String(value || "小红书笔记").replace(/\s*[|-]\s*小红书.*$/i, "").trim().slice(0, 100) || "小红书笔记";
  }

  function urlKey(url) {
    try {
      var parsed = new URL(String(url || ""), location.href);
      return parsed.pathname.replace(/\/$/, "");
    } catch (_error) { return String(url || "").split("?")[0]; }
  }

  function originalImageUrl(value) {
    var url = String(value || "");
    try {
      var parsed = new URL(url, location.href);
      if (/^\?(?:imageView2\/|x-oss-process=)/i.test(parsed.search)) return parsed.origin + parsed.pathname;
      Array.from(parsed.searchParams.keys()).forEach(function(key) {
        if (/watermark|watermarktype|^wm$|redimage/i.test(key)) parsed.searchParams.delete(key);
      });
      return parsed.toString();
    } catch (_error) { /* 保留原地址 */ }
    return url;
  }

  function recordId(type, index) {
    return "xiaohongshu:" + (note.noteId || noteId()) + ":" + type + ":" + index;
  }

  function applyNoteData(payload) {
    if (!payload || !payload.noteId || payload.noteId !== noteId()) return;
    note = {
      noteId: payload.noteId,
      title: cleanTitle(payload.title),
      author: payload.author || "",
      images: Array.isArray(payload.images) ? payload.images : [],
      videos: Array.isArray(payload.videos) ? payload.videos : [],
      isVideo: payload.isVideo === true
    };
    var activeIds = new Set();
    note.images.forEach(function(image, index) {
      var url = typeof image === "string" ? image : image && image.url;
      if (!url) return;
      if (note.isVideo || (image && image.live)) return;
      var id = recordId("image", index + 1);
      activeIds.add(id);
      media.set(id, { id: id, url: originalImageUrl(url), fileType: "image/jpeg", mediaType: "image", index: index + 1,
        width: Number(image && image.width) || 0, height: Number(image && image.height) || 0 });
      if (!selected.has(id)) selected.set(id, selectionMode === "manual" ? manualSelected.has(id) : true);
    });
    var noteVideos = note.isVideo ? note.videos.filter(function(video) { return !(video && video.live); }).slice(0, 1) : note.videos;
    noteVideos.forEach(function(video, index) {
      var url = typeof video === "string" ? video : video && video.url;
      if (!url) return;
      var id = recordId("video", index + 1);
      var slideIndex = Number(video && video.slideIndex) || 0;
      var liveCover = slideIndex > 0 ? note.images[slideIndex - 1] : null;
      activeIds.add(id);
      media.set(id, { id: id, url: url, fileType: "video/mp4", mediaType: "video",
        backupUrls: Array.isArray(video && video.backupUrls) ? video.backupUrls : [],
        isLiveVideo: !!(video && video.live), slideIndex: slideIndex,
        width: Number(liveCover && liveCover.width) || 0, height: Number(liveCover && liveCover.height) || 0,
        index: note.images.length + index + 1 });
      if (!selected.has(id)) selected.set(id, selectionMode === "manual" ? manualSelected.has(id) : true);
    });
    Array.from(media.keys()).forEach(function(id) { if (!activeIds.has(id)) { media.delete(id); selected.delete(id); } });
    scan(); updateCount();
  }

  function readInjectedState() {
    var raw = document.documentElement.getAttribute("data-aesthetic-xhs-note");
    if (!raw || raw === lastNotePayload) return;
    lastNotePayload = raw;
    try { applyNoteData(JSON.parse(raw)); } catch (_error) { /* wait for next state */ }
  }

  function visibleDetailRoot(element) {
    return element && element.closest && element.closest('[class*="note-detail" i], [class*="note-container" i], [class*="modal" i], [class*="mask" i], [class*="viewer" i], [class*="preview" i]');
  }

  function matchesKnownNoteMedia(element) {
    if (!element || !element.tagName) return false;
    var tag = element.tagName.toLowerCase();
    if (tag !== "img" && tag !== "video") return false;
    var source = element.currentSrc || element.src || "";
    var key = urlKey(source);
    if (tag === "video" && note.isVideo && /^blob:/i.test(source)) return true;
    var matched = false;
    media.forEach(function(record) {
      if (!matched && record.mediaType === (tag === "video" ? "video" : "image") && urlKey(record.url) === key) matched = true;
    });
    if (matched) return true;
    if (tag === "img") {
      return note.images.some(function(image) {
        var url = typeof image === "string" ? image : image && image.url;
        return !!url && urlKey(url) === key;
      });
    }
    return note.isVideo && note.videos.length > 0;
  }

  function isBodyMedia(element) {
    var detailRoot = visibleDetailRoot(element);
    if (!element || !detailRoot || !matchesKnownNoteMedia(element)) return false;
    if (element.closest('[class*="comment" i], [class*="reply" i], [class*="avatar" i], [class*="author" i], [class*="recommend" i], [class*="interaction" i]')) return false;
    var rect = element.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 180) return false;
    var classes = String(element.className || "") + " " + String(element.parentElement && element.parentElement.className || "");
    if (/avatar|icon|emoji|author|comment|recommend/i.test(classes)) return false;
    return true;
  }

  function currentSlideIndex(requireActuallyVisible) {
    var candidates = Array.from(document.querySelectorAll('[class*="pagination" i], [class*="indicator" i], [class*="counter" i], [class*="page" i]'));
    if (!candidates.some(function(element) { return /^\s*\d+\s*\/\s*\d+\s*$/.test(element.textContent || ""); })) {
      candidates = candidates.concat(Array.from(document.querySelectorAll("span, div")).filter(function(element) {
        return element.childElementCount <= 1 && String(element.textContent || "").trim().length <= 9;
      }));
    }
    for (var i = 0; i < candidates.length; i++) {
      var element = candidates[i], text = String(element.textContent || "").trim();
      var match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!match || Number(match[2]) < 2) continue;
      var rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
      if (requireActuallyVisible) {
        // 小红书会保留前后轮播页的计数器节点，它们自身宽高仍非零。
        // Live 只接受真正位于当前视口、且整条祖先链未隐藏的页码。
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
        var ancestor = element, hiddenByAncestor = false;
        for (var depth = 0; ancestor && depth < 10; depth++, ancestor = ancestor.parentElement) {
          var ancestorStyle = getComputedStyle(ancestor);
          if (ancestor.getAttribute && ancestor.getAttribute("aria-hidden") === "true" ||
              ancestorStyle.display === "none" || ancestorStyle.visibility === "hidden" || Number(ancestorStyle.opacity || 1) < 0.1) {
            hiddenByAncestor = true; break;
          }
        }
        if (hiddenByAncestor) continue;
      }
      return Number(match[1]);
    }
    return 0;
  }

  function mediaSemantics(element) {
    var output = "", node = element, depth = 0;
    while (node && depth++ < 6) {
      output += " " + String(node.className && (node.className.baseVal || node.className) || "") +
        " " + String(node.id || "") + " " + String(node.getAttribute && node.getAttribute("aria-label") || "");
      node = node.parentElement;
    }
    return output;
  }

  // Live 播放会在同一宿主内把封面 img 替换为 video。宿主只用于继承媒体记录，
  // 选框仍始终由 renderedMediaRect 计算，绝不使用宿主容器的尺寸。
  function liveHostForElement(element) {
    return element && element.closest ? element.closest(liveHostSelector) : null;
  }

  function liveRecordForSlide(slideIndex) {
    var matched = null;
    media.forEach(function(record) {
      if (!matched && record.isLiveVideo === true && record.slideIndex === slideIndex) matched = record;
    });
    return matched;
  }

  function liveUrlMatches(left, right) {
    var leftKey = urlKey(left).replace(/![^/]*$/, "");
    var rightKey = urlKey(right).replace(/![^/]*$/, "");
    return !!leftKey && leftKey === rightKey;
  }

  function liveRecordForMediaElement(element) {
    if (!element) return null;
    var source = element.currentSrc || element.src || "";
    if (!source || /^blob:/i.test(source)) return null;
    if (element.tagName.toLowerCase() === "img") {
      for (var imageIndex = 0; imageIndex < note.images.length; imageIndex++) {
        var noteImage = note.images[imageIndex];
        var noteImageUrl = typeof noteImage === "string" ? noteImage : noteImage && noteImage.url;
        if (noteImageUrl && liveUrlMatches(noteImageUrl, source)) return liveRecordForSlide(imageIndex + 1);
      }
      return null;
    }
    var matched = null;
    media.forEach(function(record) {
      if (matched || record.isLiveVideo !== true) return;
      var urls = [record.url].concat(record.backupUrls || []);
      if (urls.some(function(url) { return liveUrlMatches(url, source); })) matched = record;
    });
    return matched;
  }

  function liveHosts() {
    return Array.from(document.querySelectorAll(liveHostSelector));
  }

  function liveMediaElementInHost(host) {
    if (!host || !host.querySelectorAll) return null;
    var candidates = Array.from(host.querySelectorAll("img, video")).map(function(element) {
      return { element: element, score: candidateScore(element) };
    }).filter(function(item) { return item.score >= 0; });
    candidates.sort(function(left, right) { return right.score - left.score; });
    return candidates.length ? candidates[0].element : null;
  }

  // 小红书会一次性预加载所有 Live 封面。先用每张封面的 URL 为各自宿主绑定
  // slideIndex/MP4 记录，轮播时只需切换当前宿主，不再依赖首次显示后的临时绑定。
  function prebindLiveHosts() {
    liveHosts().forEach(function(host) {
      var resolved = null;
      var elements = host.querySelectorAll ? Array.from(host.querySelectorAll("img, video")) : [];
      for (var i = 0; i < elements.length && !resolved; i++) resolved = liveRecordForMediaElement(elements[i]);
      if (resolved) liveRecordByHost.set(host, resolved);
    });
  }

  function liveHostActuallyVisible(host) {
    if (!host || !host.getBoundingClientRect) return false;
    var rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    var node = host;
    for (var depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      var style = getComputedStyle(node);
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true" || style.display === "none" ||
          style.visibility === "hidden" || Number(style.opacity || 1) < 0.1) return false;
    }
    return true;
  }

  function liveHostIsActive(host) {
    return /swiper-slide-active|slide-active|carousel-item-active|\bis-active\b/i.test(mediaSemantics(host));
  }

  function activeLiveSelection() {
    prebindLiveHosts();
    var pageIndex = currentSlideIndex(true);
    var pageRecord = pageIndex > 0 ? liveRecordForSlide(pageIndex) : null;
    if (pageIndex > 0 && !pageRecord) return null;
    var entries = liveHosts().map(function(host) {
      var record = liveRecordByHost.get(host) || null;
      return { host: host, record: record, active: liveHostIsActive(host), visible: liveHostActuallyVisible(host) };
    }).filter(function(entry) { return entry.record && entry.visible; });
    var chosen = null;
    if (pageRecord) {
      chosen = entries.find(function(entry) { return entry.active && entry.record.id === pageRecord.id; }) ||
        entries.find(function(entry) { return entry.record.id === pageRecord.id; }) || null;
    } else {
      chosen = entries.find(function(entry) { return entry.active; }) || null;
    }
    if (!chosen) return null;
    var element = liveMediaElementInHost(chosen.host);
    return element ? { element: element, record: chosen.record, host: chosen.host } : null;
  }

  function candidateScore(element) {
    if (!isBodyMedia(element)) return -1;
    var rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) < 0.15) return -1;
    if (style.filter && style.filter !== "none" && /blur/i.test(style.filter)) return -1;
    var semantics = mediaSemantics(element);
    if (/blur|backdrop|background|thumbnail|avatar|recommend/i.test(semantics)) return -1;
    if (element.closest('[aria-hidden="true"]')) return -1;
    var visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    var visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    if (!visibleWidth || !visibleHeight) return -1;
    var score = visibleWidth * visibleHeight;
    if (element.tagName.toLowerCase() === "video" && note.videos.length) score += 1500000000;
    if (/swiper-slide-active|slide-active|\bactive\b/i.test(semantics)) score += 1000000000;
    if ((style.objectFit || "") === "contain") score += 10000000;
    return score;
  }

  function bestVisibleElement() {
    var candidates = Array.from(document.querySelectorAll("img, video")).map(function(element) {
      return { element: element, score: candidateScore(element) };
    }).filter(function(item) { return item.score >= 0; });
    candidates.sort(function(a, b) { return b.score - a.score; });
    return candidates.length ? candidates[0].element : null;
  }

  function recordForElement(element) {
    if (!element) return null;
    var type = element.tagName.toLowerCase() === "video" ? "video" : "image";
    var liveHost = liveHostForElement(element);
    if (note.isVideo) {
      var primaryVideo = null;
      media.forEach(function(record) { if (!primaryVideo && record.mediaType === "video" && !record.isLiveVideo) primaryVideo = record; });
      if (primaryVideo) return primaryVideo;
    }
    var source = element.currentSrc || element.src || "";
    var key = urlKey(source), matched = null;
    media.forEach(function(record) {
      if (!matched && record.mediaType === type && urlKey(record.url) === key) matched = record;
    });
    if (matched) {
      if (liveHost && matched.isLiveVideo) liveRecordByHost.set(liveHost, matched);
      return matched;
    }

    var livePhotoElement = type === "image" && (!!liveHost || /live-photo|livephoto|motion-photo/i.test(mediaSemantics(element)));
    var liveMediaElement = !!liveHost || livePhotoElement || /live-photo|livephoto|motion-photo/i.test(mediaSemantics(element));

    var index = currentSlideIndex(liveMediaElement);
    if (lastLiveSlideNoteId !== noteId()) { lastLiveSlideNoteId = noteId(); lastLiveSlideIndex = 0; }
    if (liveMediaElement && index > 0) lastLiveSlideIndex = index;
    if (liveMediaElement && !index) index = lastLiveSlideIndex;
    var inheritedLiveRecord = liveHost && liveRecordByHost.get(liveHost);
    if (inheritedLiveRecord && inheritedLiveRecord.isLiveVideo &&
        (!index || !inheritedLiveRecord.slideIndex || inheritedLiveRecord.slideIndex === index)) {
      return inheritedLiveRecord;
    }
    // Live Photo 的当前 DOM 仍是封面 img，它不在图片媒体队列中。
    // 轮播页码被站点隐藏时，用封面 URL 反查原始顺序。
    if (!index && type === "image") {
      for (var imageIndex = 0; imageIndex < note.images.length; imageIndex++) {
        var noteImage = note.images[imageIndex];
        var noteImageUrl = typeof noteImage === "string" ? noteImage : noteImage && noteImage.url;
        if (noteImageUrl && urlKey(noteImageUrl) === key) { index = imageIndex + 1; break; }
      }
    }
    if (index > 0) {
      var indexed = media.get(recordId(type, index));
      if (indexed) return indexed;
      var liveRecord = null;
      media.forEach(function(record) {
        if (!liveRecord && record.isLiveVideo && record.slideIndex === index) liveRecord = record;
      });
      if (liveRecord) {
        if (liveHost) liveRecordByHost.set(liveHost, liveRecord);
        return liveRecord;
      }
    }
    // 参考插件明确排除 .live-photo-contain 中的封面；这里在没有找到
    // 真实动态流时也不退回普通图片，避免静态图漏入待下载。
    if (livePhotoElement) return null;
    if (type === "video") {
      var videoRecords = Array.from(media.values()).filter(function(record) { return record.mediaType === "video"; });
      if (videoRecords.length === 1) return videoRecords[0];
    }
    if (!/^https?:\/\//i.test(source)) return null;
    if (!index) index = Array.from(media.values()).filter(function(item) { return item.mediaType === type; }).length + 1;
    var id = recordId(type, index);
    var record = { id: id, url: type === "image" ? originalImageUrl(source) : source,
      fileType: type === "image" ? "image/jpeg" : "video/mp4", mediaType: type, index: index,
      width: element.naturalWidth || element.videoWidth || 0, height: element.naturalHeight || element.videoHeight || 0 };
    media.set(id, record);
    if (!selected.has(id)) selected.set(id, selectionMode === "manual" ? manualSelected.has(id) : true);
    if (!note.noteId) note.noteId = noteId();
    if (!note.title || note.title === "小红书笔记") note.title = cleanTitle(document.title);
    return record;
  }

  function actualImageReady(element, record) {
    if (!element || !record || record.isLiveVideo === true || element.tagName.toLowerCase() !== "img") return true;
    return element.complete !== false && element.naturalWidth > 0 && element.naturalHeight > 0;
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

  function imageZoomViewerOpen() {
    var controls = document.querySelectorAll("button, span, div");
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (control.childElementCount > 2 || !/^\s*\d{1,3}%\s*$/.test(control.textContent || "")) continue;
      var rect = control.getBoundingClientRect(), style = getComputedStyle(control);
      if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight &&
          style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.1) return true;
    }
    return false;
  }

  // 侧边栏会改变轮播容器宽度；根据原图比例与 object-fit 计算真正绘制的图像区域。
  function renderedMediaRect(element, record) {
    var box = element.getBoundingClientRect();
    // Live 播放会在封面 img 和 video 之间切换，动态节点的 videoWidth 会短暂为 0
    // 或报告不同比例。固定使用 Live 封面尺寸，保证选框和图标不跳动。
    var sourceWidth = record.isLiveVideo ? (record.width || element.naturalWidth || element.videoWidth || 0) :
      (element.naturalWidth || element.videoWidth || record.width || 0);
    var sourceHeight = record.isLiveVideo ? (record.height || element.naturalHeight || element.videoHeight || 0) :
      (element.naturalHeight || element.videoHeight || record.height || 0);
    if (!sourceWidth || !sourceHeight || !box.width || !box.height) return box;
    var style = getComputedStyle(element);
    var fit = style.objectFit || "fill";
    var boxRatio = box.width / box.height, sourceRatio = sourceWidth / sourceHeight;
    // 小红书部分轮播把 contain 效果放在父层，但 img 自身仍报告 fill；宽高比不一致时按 contain 收紧。
    if (fit === "fill" && Math.abs(boxRatio - sourceRatio) > 0.01) fit = "contain";
    if (fit !== "contain" && fit !== "scale-down" && fit !== "none") return box;
    var scale = fit === "none" ? 1 : Math.min(box.width / sourceWidth, box.height / sourceHeight);
    if (fit === "scale-down") scale = Math.min(1, scale);
    var width = sourceWidth * scale, height = sourceHeight * scale;
    var parts = String(style.objectPosition || "50% 50%").trim().split(/\s+/);
    var xToken = parts[0] || "50%", yToken = parts[1] || "50%";
    if (/^(top|bottom)$/.test(xToken)) { yToken = xToken; xToken = "50%"; }
    var left = box.left + objectPositionOffset(xToken, box.width - width, "x");
    var top = box.top + objectPositionOffset(yToken, box.height - height, "y");
    return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
  }

  // Live 播放会放大或替换媒体节点。只在当前轮播页稳定后记录第一个
  // 实际绘制矩形，后续播放缩放不再改变选框；从不使用外层容器尺寸。
  function stableSelectionRect(element, record) {
    var rect = renderedMediaRect(element, record);
    if (!record || record.isLiveVideo !== true || !rect.width || !rect.height) return rect;
    if (!activeXhsLiveFrame || activeXhsLiveFrame.id !== record.id) {
      activeXhsLiveFrame = { id: record.id, left: rect.left, top: rect.top,
        width: rect.width, height: rect.height, scrollX: window.scrollX, scrollY: window.scrollY };
    }
    var width = activeXhsLiveFrame.width, height = activeXhsLiveFrame.height;
    var left = activeXhsLiveFrame.left - (window.scrollX - activeXhsLiveFrame.scrollX);
    var top = activeXhsLiveFrame.top - (window.scrollY - activeXhsLiveFrame.scrollY);
    return { left: left, top: top, width: width, height: height,
      right: left + width, bottom: top + height };
  }

  function cleanupXhsLayers() {
    document.querySelectorAll(".xhs-dl-image-layer, .xhs-dl-fixed-badge").forEach(function(node) { node.remove(); });
    document.querySelectorAll("[data-xhs-direct]").forEach(function(element) {
      element.classList.remove("xhs-dl-direct-selected", "xhs-dl-direct-deselected", "xhs-dl-motion-hidden");
      element.removeAttribute("data-xhs-direct");
    });
    document.querySelectorAll(".xhs-dl-overlay-host").forEach(function(host) {
      host.classList.remove("xhs-dl-overlay-host", "huaban-dl-card", "huaban-dl-selected", "huaban-dl-deselected");
    });
    activeXhsElement = null;
    activeXhsOutlineElement = null;
    activeXhsUsesFixedOutline = false;
    activeXhsRecord = null;
    activeXhsSelected = null;
    activeXhsBox = null;
    activeXhsStableFrames = 0;
    activeXhsMotionStable = false;
    activeXhsLiveFrame = null;
    activeXhsLiveHostBox = null;
    livePageScrolling = false;
    if (liveScrollTimer) { clearTimeout(liveScrollTimer); liveScrollTimer = null; }
  }

  function leaveNoteImmediately() {
    if (!media.size && !note.noteId && !activeXhsElement && !document.getElementById("xhs-dl-active-outline") &&
        !document.getElementById("xhs-dl-active-badge")) return;
    media.clear();
    selected.clear();
    cleanupXhsLayers();
    lastLiveSlideIndex = 0;
    lastLiveSlideNoteId = "";
    liveRecordByHost = new WeakMap();
    note = { noteId: "", title: "小红书笔记", author: "", images: [], videos: [], isVideo: false };
    lastNotePayload = "";
    lastSelectionMessage = "";
    updateCount();
  }

  function outlineElementForMedia(element) {
    if (!element || element.tagName.toLowerCase() !== "video") return element;
    var mediaBox = element.getBoundingClientRect(), node = element.parentElement, fallback = null;
    for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      var box = node.getBoundingClientRect();
      var closeSize = Math.abs(box.width - mediaBox.width) <= Math.max(24, mediaBox.width * 0.08) &&
        Math.abs(box.height - mediaBox.height) <= Math.max(24, mediaBox.height * 0.08);
      if (!closeSize) break;
      if (!fallback) fallback = node;
      var semantics = String(node.className && (node.className.baseVal || node.className) || "") + " " + String(node.id || "");
      if (/player|video|media/i.test(semantics)) return node;
    }
    // 视频控制层会覆盖 <video> 的 outline，所以至少绑到第一个同尺寸外层。
    return fallback || element;
  }

  function cleanupLegacyHosts() {
    document.querySelectorAll(".xhs-dl-overlay-host").forEach(function(host) {
      host.querySelectorAll(":scope > .xhs-dl-image-layer, :scope > .huaban-dl-badge[data-xhs-id]").forEach(function(node) { node.remove(); });
      host.classList.remove("xhs-dl-overlay-host", "huaban-dl-card", "huaban-dl-selected", "huaban-dl-deselected");
    });
  }

  function decorate(record, element) {
    if (!record || !element) { cleanupXhsLayers(); return; }
    cleanupLegacyHosts();
    var currentLiveHost = record.isLiveVideo === true ? liveHostForElement(element) : null;
    if (currentLiveHost) liveRecordByHost.set(currentLiveHost, record);
    var isSelected = selected.get(record.id) !== false;
    // Live 无论当前展示的是封面 img 还是动态 video，都共用同一个 fixed 逻辑选框。
    var usesFixedOutline = record.isLiveVideo === true || element.tagName.toLowerCase() !== "video";
    var outlineElement = usesFixedOutline ? null : outlineElementForMedia(element);
    var liveRecordChanged = record.isLiveVideo === true && (!activeXhsRecord || activeXhsRecord.id !== record.id);
    var preserveLiveVisual = record.isLiveVideo === true && activeXhsRecord && activeXhsRecord.id === record.id &&
      activeXhsSelected === isSelected && activeXhsUsesFixedOutline && usesFixedOutline;
    if (activeXhsElement !== element || activeXhsOutlineElement !== outlineElement || activeXhsUsesFixedOutline !== usesFixedOutline || activeXhsRecord !== record || activeXhsSelected !== isSelected) {
      if (activeXhsOutlineElement && activeXhsOutlineElement !== outlineElement) {
        activeXhsOutlineElement.classList.remove("xhs-dl-direct-selected", "xhs-dl-direct-deselected", "xhs-dl-motion-hidden");
        activeXhsOutlineElement.removeAttribute("data-xhs-direct");
      }
      if (outlineElement) {
        outlineElement.setAttribute("data-xhs-direct", record.id);
        outlineElement.classList.toggle("xhs-dl-direct-selected", isSelected);
        outlineElement.classList.toggle("xhs-dl-direct-deselected", !isSelected);
        outlineElement.classList.add("xhs-dl-motion-hidden");
      }
      activeXhsElement = element;
      activeXhsOutlineElement = outlineElement;
      activeXhsUsesFixedOutline = usesFixedOutline;
      activeXhsRecord = record;
      activeXhsSelected = isSelected;
      if (liveRecordChanged) {
        activeXhsLiveFrame = null;
        activeXhsLiveHostBox = null;
      }
      if (preserveLiveVisual) {
        var preservedBox = element.getBoundingClientRect();
        activeXhsBox = { left: preservedBox.left, top: preservedBox.top, width: preservedBox.width, height: preservedBox.height };
        activeXhsStableFrames = Math.max(2, activeXhsStableFrames);
        activeXhsMotionStable = true;
      } else {
        activeXhsBox = null;
        activeXhsStableFrames = 0;
        activeXhsMotionStable = false;
      }
    }
    var fixedOutline = document.getElementById("xhs-dl-active-outline");
    if (usesFixedOutline && !fixedOutline) {
      fixedOutline = document.createElement("div");
      fixedOutline.id = "xhs-dl-active-outline";
      document.body.appendChild(fixedOutline);
    }
    if (fixedOutline) {
      fixedOutline.className = "xhs-dl-image-layer " + (isSelected ? "is-selected" : "is-deselected");
      fixedOutline.style.display = "none";
    }
    var badge = document.getElementById("xhs-dl-active-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "xhs-dl-active-badge";
      document.body.appendChild(badge);
    }
    badge.className = "huaban-dl-badge xhs-dl-fixed-badge " + (isSelected ? "is-selected" : "is-deselected") +
      (record.isLiveVideo === true ? " is-live" : "");
    badge.dataset.xhsId = record.id;
    badge.textContent = isSelected ? "✓" : (selectionMode === "manual" ? "" : "✗");
    badge.onclick = record.isLiveVideo === true ? null : function(event) {
      event.preventDefault(); event.stopPropagation();
      var choose = selected.get(record.id) === false;
      selected.set(record.id, choose);
      if (selectionMode === "manual") { if (choose) manualSelected.add(record.id); else manualSelected.delete(record.id); }
      if (choose) restorePending(record); else removePending(record);
      decorate(record, element); updateCount();
    };
    syncActiveBadge();
  }

  function liveBadgeContainsPoint(event) {
    var badge = document.getElementById("xhs-dl-active-badge");
    if (!badge || !activeXhsRecord || activeXhsRecord.isLiveVideo !== true || badge.style.display === "none") return false;
    var rect = badge.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  // Live 点击在捕获阶段按图标的固定坐标处理，并阻止站点收到该次点击。
  function captureLiveBadgePointer(event) {
    if (!liveBadgeContainsPoint(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (event.type !== "click") return;
    var record = activeXhsRecord, element = activeXhsElement;
    var choose = selected.get(record.id) === false;
    selected.set(record.id, choose);
    if (selectionMode === "manual") { if (choose) manualSelected.add(record.id); else manualSelected.delete(record.id); }
    if (choose) restorePending(record); else removePending(record);
    decorate(record, element);
    updateCount();
  }

  // 轮廓由媒体元素自身绘制；这里只同步小角标，不再用独立 fixed 大框追踪轮播。
  function syncActiveBadge() {
    var badge = document.getElementById("xhs-dl-active-badge");
    var fixedOutline = document.getElementById("xhs-dl-active-outline");
    var currentLivePage = activeXhsRecord && activeXhsRecord.isLiveVideo === true ? currentSlideIndex(true) : 0;
    var retainedLiveFrame = activeXhsRecord && activeXhsRecord.isLiveVideo === true && activeXhsLiveFrame &&
      activeXhsLiveFrame.id === activeXhsRecord.id && (!currentLivePage || currentLivePage === activeXhsRecord.slideIndex);
    if (!badge || !activeXhsElement || !activeXhsRecord || !activeXhsMotionStable ||
        !activeXhsElement.isConnected && !retainedLiveFrame) {
      if (badge) badge.style.display = "none";
      if (fixedOutline) fixedOutline.style.display = "none";
      return;
    }
    var rect = stableSelectionRect(activeXhsElement, activeXhsRecord);
    var visibleLeft = Math.max(0, rect.left), visibleTop = Math.max(0, rect.top);
    var visibleRight = Math.min(innerWidth, rect.right), visibleBottom = Math.min(innerHeight, rect.bottom);
    var carouselStillVisible = note.images.length <= 1 || currentSlideIndex(activeXhsRecord.isLiveVideo === true) > 0 || retainedLiveFrame;
    var visible = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight &&
      carouselStillVisible;
    if (fixedOutline) {
      fixedOutline.style.display = visible && activeXhsUsesFixedOutline ? "block" : "none";
      if (visible && activeXhsUsesFixedOutline) {
        fixedOutline.style.left = rect.left + "px";
        fixedOutline.style.top = rect.top + "px";
        fixedOutline.style.width = rect.width + "px";
        fixedOutline.style.height = rect.height + "px";
      }
    }
    badge.style.display = visible ? "flex" : "none";
    if (!visible) return;
    badge.style.left = Math.max(4, Math.min(innerWidth - 28, rect.right - 32)) + "px";
    badge.style.top = Math.max(4, Math.min(innerHeight - 28, rect.bottom - 32)) + "px";
  }

  function hideLiveVisualsDuringScroll() {
    var badge = document.getElementById("xhs-dl-active-badge");
    var outline = document.getElementById("xhs-dl-active-outline");
    if (badge) badge.style.display = "none";
    if (outline) outline.style.display = "none";
  }

  // 页面或弹层滚动时立即隐藏所有 fixed 选框，禁止沿用旧坐标覆盖评论区。
  // 滚动停止后清空旧帧，再由当前实际媒体区域稳定两帧后重新定位。
  function handleLiveScroll() {
    if (!activeXhsRecord) return;
    livePageScrolling = true;
    hideLiveVisualsDuringScroll();
    if (liveScrollTimer) clearTimeout(liveScrollTimer);
    liveScrollTimer = setTimeout(function() {
      liveScrollTimer = null;
      livePageScrolling = false;
      activeXhsLiveFrame = null;
      activeXhsLiveHostBox = null;
      activeXhsBox = null;
      activeXhsStableFrames = 0;
      activeXhsMotionStable = false;
      scheduleScan();
    }, 160);
  }

  function animationSync() {
    // 小红书关闭详情弹层时会先切回列表 URL；在下一动画帧立即删除 fixed 选框，
    // 不再等待 MutationObserver、定时扫描或旧媒体节点从 DOM 中移除。
    if (pageType() !== "note") {
      leaveNoteImmediately();
      requestAnimationFrame(animationSync);
      return;
    }
    if (pluginEnabled && pageType() === "note" && activeXhsElement && activeXhsElement.isConnected) {
      if (livePageScrolling) {
        hideLiveVisualsDuringScroll();
        requestAnimationFrame(animationSync);
        return;
      }
      var box = activeXhsElement.getBoundingClientRect();
      if (activeXhsRecord && activeXhsRecord.isLiveVideo === true) {
        var visibleLivePage = currentSlideIndex(true);
        if (visibleLivePage > 0 && activeXhsRecord.slideIndex > 0 && activeXhsRecord.slideIndex !== visibleLivePage) {
          activeXhsMotionStable = false;
          var changingBadge = document.getElementById("xhs-dl-active-badge");
          if (changingBadge) changingBadge.style.display = "none";
          var changingOutline = document.getElementById("xhs-dl-active-outline");
          if (changingOutline) changingOutline.style.display = "none";
          scheduleScan();
          requestAnimationFrame(animationSync);
          return;
        }
        // 和普通图片一致：当前页首次稳定后固定选框。Live 播放缩放、鼠标离开和
        // img/video 节点替换都不再视为轮播移动，只有真实页码变化才换绑。
        if (activeXhsLiveFrame && activeXhsLiveFrame.id === activeXhsRecord.id) {
          activeXhsMotionStable = true;
          syncActiveBadge();
          requestAnimationFrame(animationSync);
          return;
        }
        var activeLiveHost = liveHostForElement(activeXhsElement);
        var liveTrackingBox = activeLiveHost && activeLiveHost.getBoundingClientRect ? activeLiveHost.getBoundingClientRect() : box;
        var liveHostMoved = activeXhsLiveHostBox && (Math.abs(liveTrackingBox.left - activeXhsLiveHostBox.left) > 0.5 ||
          Math.abs(liveTrackingBox.top - activeXhsLiveHostBox.top) > 0.5 || Math.abs(liveTrackingBox.width - activeXhsLiveHostBox.width) > 0.5 ||
          Math.abs(liveTrackingBox.height - activeXhsLiveHostBox.height) > 0.5);
        activeXhsLiveHostBox = { left: liveTrackingBox.left, top: liveTrackingBox.top,
          width: liveTrackingBox.width, height: liveTrackingBox.height };
        if (liveHostMoved) {
          activeXhsMotionStable = false;
          activeXhsStableFrames = 0;
          var changingBadge = document.getElementById("xhs-dl-active-badge");
          if (changingBadge) changingBadge.style.display = "none";
          var changingOutline = document.getElementById("xhs-dl-active-outline");
          if (changingOutline) changingOutline.style.display = "none";
          scheduleScan();
          requestAnimationFrame(animationSync);
          return;
        }
        activeXhsStableFrames++;
        activeXhsBox = { left: box.left, top: box.top, width: box.width, height: box.height };
        if (activeXhsStableFrames >= 2) {
          activeXhsMotionStable = true;
          // 宿主稳定后才记录实际画面；之后播放缩放不会改变已锁定的选框。
          syncActiveBadge();
        }
        requestAnimationFrame(animationSync);
        return;
      }
      var moved = activeXhsBox && (Math.abs(box.left - activeXhsBox.left) > 0.5 ||
        Math.abs(box.top - activeXhsBox.top) > 0.5 || Math.abs(box.width - activeXhsBox.width) > 0.5 ||
        Math.abs(box.height - activeXhsBox.height) > 0.5);
      activeXhsBox = { left: box.left, top: box.top, width: box.width, height: box.height };
      if (moved) {
        activeXhsStableFrames = 0;
        activeXhsMotionStable = false;
        if (activeXhsOutlineElement) activeXhsOutlineElement.classList.add("xhs-dl-motion-hidden");
        var movingBadge = document.getElementById("xhs-dl-active-badge");
        if (movingBadge) movingBadge.style.display = "none";
        var movingOutline = document.getElementById("xhs-dl-active-outline");
        if (movingOutline) movingOutline.style.display = "none";
        scheduleScan();
      } else if (activeXhsBox) {
        activeXhsStableFrames++;
        if (activeXhsStableFrames >= 2) {
          activeXhsMotionStable = true;
          if (activeXhsOutlineElement) activeXhsOutlineElement.classList.remove("xhs-dl-motion-hidden");
          syncActiveBadge();
        }
      }
    }
    requestAnimationFrame(animationSync);
  }

  function scan() {
    if (!pluginEnabled) return;
    if (pageType() !== "note") {
      leaveNoteImmediately(); return;
    }
    readInjectedState();
    var liveSelection = activeLiveSelection();
    var livePageIndex = currentSlideIndex(true);
    var livePageRecord = livePageIndex > 0 ? liveRecordForSlide(livePageIndex) : null;
    var retainCurrentLiveFrame = !liveSelection && activeXhsRecord && activeXhsRecord.isLiveVideo === true &&
      activeXhsLiveFrame && activeXhsLiveFrame.id === activeXhsRecord.id &&
      (!livePageIndex || activeXhsRecord.slideIndex === livePageIndex);
    if (retainCurrentLiveFrame) {
      activeXhsMotionStable = true;
      syncActiveBadge();
      updateCount();
      return;
    }
    var element = liveSelection ? liveSelection.element : bestVisibleElement();
    var record = liveSelection ? liveSelection.record : recordForElement(element);
    // 普通图片进入带百分比缩放工具栏的放大查看器后不展示选框；
    // 视频和 Live 继续沿用原有逻辑。关闭放大层后定时扫描会自动恢复。
    if (record && record.mediaType === "image" && imageZoomViewerOpen()) {
      decorate(null, null);
      updateCount();
      return;
    }
    // 当前页已经确认是 Live，但宿主或媒体节点还在轮播切换中时直接隐藏，
    // 禁止回退到全局候选并误用上一页/预加载节点。
    if (!liveSelection && livePageRecord) {
      decorate(null, null);
      updateCount();
      return;
    }
    if (record && !actualImageReady(element, record)) {
      decorate(null, null);
      updateCount();
      return;
    }
    decorate(record, element);
    updateCount();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function() { scanTimer = null; scan(); }, 80);
  }

  function updateCount() {
    var count = 0;
    selected.forEach(function(value) { if (value) count++; });
    var manualCount = selected.size - count;
    var signature = [count, selected.size, note.noteId].join(":");
    if (signature === lastSelectionMessage) return;
    lastSelectionMessage = signature;
    safeSend({ action: "SELECTION_COUNT", selected: count, total: selected.size, itemLabel: "项媒体",
      filterStats: { accepted: count, suspicious: 0, rejected: 0, manualExcluded: manualCount } });
  }

  function collect() {
    var output = [];
    media.forEach(function(record, id) {
      if (selected.get(id) === false) return;
      output.push(queueItem(record));
    });
    if (!output.length) { safeSend({ action: "WORK_SELECTION_EMPTY", message: "本笔记已取消选择；如需采集，请先重新选中" }); return; }
    safeSend({ action: "COLLECT_START", total: output.length });
    chrome.runtime.sendMessage({ action: "ADD_IMAGES", boardInfo: queueBoardInfo(), pins: output }, function(result) {
      if (chrome.runtime.lastError) { safeSend({ action: "ERROR", message: "小红书媒体加入待下载失败" }); return; }
      media.forEach(function(record, id) { if (selected.get(id) === false) removePending(record); });
      safeSend({ action: "COLLECT_DONE", ok: output.length, fail: 0,
        added: result ? result.added : output.length, skipped: result ? result.skipped : 0 });
    });
  }

  chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
    if (msg.action === "UPDATE_PLUGIN_ENABLED") {
      pluginEnabled = msg.enabled !== false;
      document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
      if (pluginEnabled) scan(); else cleanupXhsLayers();
      sendResponse({ ok: true, enabled: pluginEnabled }); return;
    }
    if (msg.action === "DETECT_PAGE") {
      var selectedCount = 0;
      selected.forEach(function(value) { if (value) selectedCount++; });
      sendResponse({ pageType: pageType(), site: "xiaohongshu", pageTitle: note.title || cleanTitle(document.title),
        selected: selectedCount, total: selected.size,
        filterStats: { accepted: selectedCount, suspicious: 0, rejected: 0, manualExcluded: selected.size - selectedCount } }); return;
    }
    if (msg.action === "SET_WORK_SELECTION") {
      var choose = msg.selected !== false;
      selected.forEach(function(_value, id) { selected.set(id, choose); });
      if (selectionMode === "manual") selected.forEach(function(_value, id) { if (choose) manualSelected.add(id); else manualSelected.delete(id); });
      scan(); lastSelectionMessage = ""; updateCount();
      sendResponse({ ok: true, selected: choose, total: selected.size, boardId: boardId() }); return;
    }
    if (msg.action === "UPDATE_SELECTION_MODE") {
      selectionMode = msg.mode === "manual" ? "manual" : "auto";
      document.documentElement.classList.toggle("huaban-dl-manual-mode", selectionMode === "manual");
      selected.forEach(function(_value, id) { selected.set(id, selectionMode === "manual" ? manualSelected.has(id) : true); });
      scan(); lastSelectionMessage = ""; updateCount();
      sendResponse({ ok: true, mode: selectionMode }); return;
    }
    if (msg.action === "COLLECT") {
      if (!pluginEnabled) { safeSend({ action: "ERROR", message: "插件已关闭" }); sendResponse({ started: false }); return; }
      collect(); sendResponse({ started: true }); return true;
    }
    if (msg.action === "UPDATE_FILTER_SETTINGS" || msg.action === "ABORT") { sendResponse({ ok: true }); return; }
  });

  chrome.storage.local.get(["aesthetic_collector_enabled", "aesthetic_selection_mode"], function(data) {
    pluginEnabled = data.aesthetic_collector_enabled !== false;
    selectionMode = data.aesthetic_selection_mode === "manual" ? "manual" : "auto";
    document.documentElement.classList.toggle("huaban-dl-manual-mode", selectionMode === "manual");
    document.documentElement.classList.toggle("huaban-dl-plugin-disabled", !pluginEnabled);
    scan();
  });
  document.addEventListener("aesthetic-xhs-note-ready", readInjectedState);
  document.addEventListener("load", scheduleScan, true);
  document.addEventListener("pointerdown", captureLiveBadgePointer, true);
  document.addEventListener("click", captureLiveBadgePointer, true);
  document.addEventListener("scroll", handleLiveScroll, true);
  new MutationObserver(function(mutations) {
    var onlyPluginLayers = mutations.every(function(mutation) {
      var target = mutation.target && (mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement);
      return target && target.closest && (target.closest(".xhs-dl-image-layer, .xhs-dl-fixed-badge") ||
        (mutation.type === "attributes" && target.hasAttribute("data-xhs-direct")));
    });
    if (!onlyPluginLayers) scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "class"] });
  addEventListener("popstate", scheduleScan);
  addEventListener("resize", scheduleScan);
  setInterval(scheduleScan, 1000);
  requestAnimationFrame(animationSync);
})();
