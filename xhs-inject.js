(function() {
  "use strict";

  var lastSignature = "";
  var fallbackVideoUrls = [];
  var fallbackNoteId = "";
  var fallbackBusy = false;
  var fallbackLastAttempt = 0;
  var liveUrlsBySlide = {};
  var liveSlidesByIndex = {};
  var liveResourceGroups = [];
  var liveResourceUrlSeen = new Set();
  var liveResourceSequence = 0;
  var liveResourceStartedAt = 0;
  var liveUrlsNoteId = "";

  function noteId() {
    var match = location.pathname.match(/\/(?:explore|discovery\/item)\/([a-z0-9]+)/i);
    return match ? match[1] : "";
  }

  function firstUrl(value) {
    if (!value) return "";
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var found = firstUrl(value[i]);
        if (found) return found;
      }
    }
    if (typeof value === "object") {
      var preferred = ["urlDefault", "urlPre", "masterUrl", "backupUrl", "url", "src"];
      for (var p = 0; p < preferred.length; p++) {
        var direct = firstUrl(value[preferred[p]]);
        if (direct) return direct;
      }
      if (value.infoList) return firstUrl(value.infoList);
    }
    return "";
  }

  function originalImageUrl(value) {
    var url = String(value || "");
    if (!/^https?:\/\//i.test(url)) return "";
    try {
      var parsed = new URL(url);
      if (/^\?(?:imageView2\/|x-oss-process=)/i.test(parsed.search)) return parsed.origin + parsed.pathname;
      Array.from(parsed.searchParams.keys()).forEach(function(key) {
        if (/watermark|watermarktype|^wm$|redimage/i.test(key)) parsed.searchParams.delete(key);
      });
      return parsed.toString();
    } catch (_error) { /* 保留原地址 */ }
    return url;
  }

  function imageInfo(image) {
    var candidates = [];
    function add(value, scene) {
      var url = firstUrl(value);
      if (!url) return;
      var widthMatch = url.match(/(?:\/w\/|[?&](?:w|width)=)(\d+)/i);
      var score = widthMatch ? parseInt(widthMatch[1], 10) : 100000;
      if (/WB_DFT|DEFAULT|ORIGINAL/i.test(scene || "")) score += 1000000;
      candidates.push({ url: originalImageUrl(url), score: score });
    }
    (image && image.infoList || []).forEach(function(info) { add(info && (info.url || info), info && (info.imageScene || info.scene)); });
    add(image && image.urlDefault, "DEFAULT");
    add(image && image.urlPre, "PREVIEW");
    add(image && image.url, image && image.imageScene);
    candidates.sort(function(a, b) { return b.score - a.score; });
    return {
      url: candidates.length ? candidates[0].url : originalImageUrl(firstUrl(image)),
      width: Number(image && (image.width || image.imageWidth)) || 0,
      height: Number(image && (image.height || image.imageHeight)) || 0
    };
  }

  function findNote(state, id) {
    if (!state || !id) return null;
    var detailMap = state.note && state.note.noteDetailMap;
    if (detailMap) {
      var direct = detailMap[id] || detailMap["note_" + id];
      if (direct) return direct.note || direct;
      var values = Object.keys(detailMap).map(function(key) { return detailMap[key]; });
      for (var i = 0; i < values.length; i++) {
        var candidate = values[i] && (values[i].note || values[i]);
        if (candidate && String(candidate.noteId || candidate.id || "") === id) return candidate;
      }
    }
    var common = [state.note && state.note.currentNote, state.note && state.note.noteInfo,
      state.noteData, state.noteDetail, state.currentNote];
    for (var j = 0; j < common.length; j++) {
      var item = common[j] && (common[j].note || common[j]);
      if (item && (!item.noteId || String(item.noteId) === id)) return item;
    }
    return null;
  }

  function videoUrls(video) {
    var candidates = [], seen = new Set(), visited = new Set(), count = 0;
    function walk(value, key, path) {
      if (!value || count++ > 3000) return;
      if (typeof value === "string") {
        if (/origin_?video_?key/i.test(key || "") && !/^https?:\/\//i.test(value)) {
          value = "https://sns-video-bd.xhscdn.com/" + value.replace(/^\/+/, "");
        }
        var fullPath = String(path || "") + "." + String(key || "");
        var isVideoUrl = /^https?:\/\//i.test(value) && (/\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(value) ||
          /sns-video|video[^/]*\.xhscdn/i.test(value) || /master_?url|backup_?urls?|video_?url|stream_?url/i.test(key || ""));
        var isImageUrl = /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(value) || /sns-img/i.test(value);
        if (isVideoUrl && !isImageUrl && !seen.has(value)) {
          seen.add(value);
          var score = 0;
          if (/\.mp4(?:[?#]|$)/i.test(value)) score += 1000;
          if (/_114\.mp4(?:[?#]|$)/i.test(value)) score += 500;
          else if (/_115\.mp4(?:[?#]|$)/i.test(value)) score += 400;
          else if (/_84\.mp4(?:[?#]|$)/i.test(value)) score += 100;
          if (/master_?url|origin|original/i.test(fullPath)) score += 300;
          if (/h264|avc/i.test(fullPath)) score += 200;
          if (/h265|hevc/i.test(fullPath)) score += 100;
          if (/backup/i.test(fullPath)) score -= 50;
          if (/\.m3u8(?:[?#]|$)/i.test(value)) score -= 1000;
          candidates.push({ url: value, score: score, order: candidates.length });
        }
        return;
      }
      if (typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) value.forEach(function(item, index) { walk(item, key, (path || "") + "[" + index + "]"); });
      else Object.keys(value).forEach(function(childKey) { walk(value[childKey], childKey, (path || "") + "." + childKey); });
    }
    walk(video, "video", "video");
    candidates.sort(function(a, b) { return b.score - a.score || a.order - b.order; });
    return candidates.map(function(item) { return item.url; });
  }

  function decodedHtmlUrl(value) {
    try { return JSON.parse('"' + String(value || "").replace(/"/g, '\\"') + '"'); }
    catch (_error) { return String(value || "").replace(/\\u002F/gi, "/").replace(/\\\//g, "/"); }
  }

  function visibleSlideIndex() {
    if (!document.querySelectorAll) return 0;
    var candidates = Array.from(document.querySelectorAll('[class*="pagination" i], [class*="indicator" i], [class*="counter" i], [class*="page" i], span, div'));
    for (var index = 0; index < candidates.length; index++) {
      var element = candidates[index];
      if (element.childElementCount > 1 || String(element.textContent || "").trim().length > 9) continue;
      var match = String(element.textContent || "").trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!match || Number(match[2]) < 2) continue;
      var rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") return Number(match[1]);
    }
    return 0;
  }

  function visibleLiveMarker() {
    if (!document.querySelectorAll) return false;
    var selectors = '.live-photo-contain, [class*="live-photo" i], [class*="livephoto" i], [class*="motion-photo" i], [class*="live" i]';
    return Array.from(document.querySelectorAll(selectors)).some(function(element) {
      var semantics = String(element.className || "") + " " + String(element.getAttribute && element.getAttribute("class") || "");
      var label = String(element.textContent || "").trim();
      if (!/live-photo|livephoto|motion-photo/i.test(semantics) && !/^live$/i.test(label)) return false;
      var rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function liveResourceKey(value) {
    try {
      var parsed = new URL(String(value || ""));
      return parsed.pathname.replace(/_(?:84|114|115)(?=\.mp4(?:$|\/))/ig, "_quality");
    } catch (_error) {
      return String(value || "").split(/[?#]/)[0].replace(/_(?:84|114|115)(?=\.mp4(?:$|\/))/ig, "_quality");
    }
  }

  function rememberLiveResourceUrls(values, startTime) {
    var list = Array.isArray(values) ? values : [values];
    list.forEach(function(value) {
      videoUrls(value).forEach(function(url) {
        if (liveResourceUrlSeen.has(url)) return;
        liveResourceUrlSeen.add(url);
        var key = liveResourceKey(url);
        var group = liveResourceGroups.find(function(item) { return item.key === key; });
        var order = Number(startTime) || 0;
        if (!group) {
          group = { key: key, urls: [], assignedSlide: 0, firstTime: order, sequence: liveResourceSequence++ };
          liveResourceGroups.push(group);
        }
        group.urls = videoUrls([group.urls, url]);
      });
    });
  }

  function scanLiveResourceEntries() {
    if (typeof performance === "undefined" || !performance.getEntriesByType) return;
    performance.getEntriesByType("resource").forEach(function(entry) {
      var name = String(entry && entry.name || ""), startTime = Number(entry && entry.startTime) || 0;
      if (!name || (liveResourceStartedAt && startTime && startTime < liveResourceStartedAt)) return;
      if (videoUrls(name).length) rememberLiveResourceUrls(name, startTime);
    });
  }

  function markLiveResourceGroupAssigned(urls, slideIndex) {
    var urlSet = new Set(videoUrls(urls));
    liveResourceGroups.some(function(group) {
      if (!group.urls.some(function(url) { return urlSet.has(url); })) return false;
      group.assignedSlide = slideIndex;
      return true;
    });
  }

  // 一个 Live 页只取一组真实视频流。同一视频的 _84/_114/_115 是清晰度备选，
  // 不能再把多个轮播页的流都合并成第一页的 backupUrls。
  function recentLiveResourceUrls(slideIndex) {
    if (liveUrlsBySlide[slideIndex] && liveUrlsBySlide[slideIndex].length) return liveUrlsBySlide[slideIndex];
    scanLiveResourceEntries();
    var available = liveResourceGroups.filter(function(group) { return !group.assignedSlide && group.urls.length; });
    available.sort(function(a, b) { return a.firstTime - b.firstTime || a.sequence - b.sequence; });
    if (!available.length) return [];
    available[0].assignedSlide = slideIndex;
    return available[0].urls;
  }

  function assignCompleteLiveResourceBatch(totalSlides) {
    if (totalSlides < 2 || (!visibleLiveMarker() && !Object.keys(liveSlidesByIndex).length)) return;
    scanLiveResourceEntries();
    var groups = liveResourceGroups.filter(function(group) { return group.urls.length; });
    if (groups.length < totalSlides) return;
    groups.sort(function(a, b) { return a.firstTime - b.firstTime || a.sequence - b.sequence; });
    // 详情页 HTML 可能一次返回全部 Live 流。取最后一批与媒体数量相同的流，
    // 按页面原始顺序分配，并在入队前把对应 WebP 封面标记为 Live。
    groups = groups.slice(groups.length - totalSlides);
    groups.forEach(function(group, index) {
      var slideIndex = index + 1;
      group.assignedSlide = slideIndex;
      liveUrlsBySlide[slideIndex] = group.urls;
      liveSlidesByIndex[slideIndex] = true;
    });
  }

  // 每切到一个 Live 页，小红书才可能创建该页的视频节点。按当前页码缓存其
  // 真实流，随后发布为对应 slideIndex；选框实现仍完全沿用 1.7.3。
  function captureVisibleLiveVideo(id) {
    if (liveUrlsNoteId !== id) {
      liveUrlsNoteId = id;
      liveUrlsBySlide = {};
      liveSlidesByIndex = {};
      liveResourceGroups = [];
      liveResourceUrlSeen = new Set();
      liveResourceSequence = 0;
      liveResourceStartedAt = typeof performance !== "undefined" && typeof performance.now === "function" ?
        Math.max(0, performance.now() - 20000) : 0;
    }
    if (!document.querySelectorAll) return;
    var slideIndex = visibleSlideIndex();
    if (!slideIndex) return;
    var isLiveSlide = visibleLiveMarker() || liveSlidesByIndex[slideIndex] === true;
    if (isLiveSlide) liveSlidesByIndex[slideIndex] = true;
    var candidates = Array.from(document.querySelectorAll("video")).map(function(video) {
      var rect = video.getBoundingClientRect(), style = getComputedStyle(video);
      var visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      var visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      var source = video.querySelector("source");
      var urls = videoUrls([video.currentSrc, video.src, video.getAttribute("src"), video.getAttribute("data-src"),
        source && source.src, source && source.getAttribute("src"), source && source.getAttribute("data-src")]);
      return { urls: urls, score: style.display === "none" || style.visibility === "hidden" ? 0 : visibleWidth * visibleHeight };
    }).filter(function(item) { return item.score > 0 && item.urls.length; });
    candidates.sort(function(a, b) { return b.score - a.score; });
    // 已跑通版本仍优先使用页面暴露的真实 MP4；小红书改用 blob: 播放时，
    // 再复用浏览器已加载的底层媒体资源，不把 Live 封面当作下载结果。
    var urls = candidates.length ? candidates[0].urls : [];
    if (urls.length) {
      rememberLiveResourceUrls(urls, typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0);
      markLiveResourceGroupAssigned(urls, slideIndex);
    } else if (isLiveSlide) {
      urls = recentLiveResourceUrls(slideIndex);
    }
    if (urls.length) {
      liveSlidesByIndex[slideIndex] = true;
      liveUrlsBySlide[slideIndex] = videoUrls([liveUrlsBySlide[slideIndex] || [], urls]);
    }
  }

  async function refreshFallbackVideoUrls(id) {
    if (!id || fallbackBusy) return;
    if (fallbackNoteId === id && fallbackVideoUrls.length) return;
    if (fallbackNoteId !== id) { fallbackNoteId = id; fallbackVideoUrls = []; fallbackLastAttempt = 0; }
    if (Date.now() - fallbackLastAttempt < 1200) return;
    fallbackLastAttempt = Date.now(); fallbackBusy = true;
    var found = [];
    try {
      if (document.querySelector) {
        var meta = document.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[name="og:video"]');
        if (meta && meta.content) found.push(meta.content);
      }
      if (document.querySelectorAll) {
        Array.from(document.querySelectorAll("video, video source")).forEach(function(element) {
          var url = element.currentSrc || element.src || "";
          if (/^https?:\/\//i.test(url) && !/^blob:/i.test(url)) found.push(url);
        });
      }
      if (typeof fetch === "function") {
        var response = await fetch(location.href, { credentials: "include" });
        if (response.ok) {
          var html = await response.text(), match;
          var pattern = /"(?:masterUrl|master_url)"\s*:\s*"([^"]+)"/g;
          while ((match = pattern.exec(html))) found.push(decodedHtmlUrl(match[1]));
        }
      }
    } catch (_error) { /* 页面状态仍是主路径，此处只做兜底 */ }
    fallbackVideoUrls = videoUrls(found);
    // 参考已跑通的抓取逻辑：从详情 HTML 中的 masterUrl 恢复真实媒体。
    // 这里保留每个视频的独立分组，不再把全部地址压成一个视频的备用链。
    rememberLiveResourceUrls(found, typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0);
    fallbackBusy = false;
    publish();
  }

  function publish() {
    var id = noteId();
    if (!id) return;
    captureVisibleLiveVideo(id);
    refreshFallbackVideoUrls(id);
    var state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__ || window.__INITIAL_DATA__;
    var note = findNote(state, id);
    if (!note) return;
    var imageList = note.imageList || note.image_list || note.images || [];
    assignCompleteLiveResourceBatch(imageList.length);
    var images = [], imageSeen = new Set();
    function liveValue(image) {
      if (!image) return null;
      var explicit = image.livePhotoInfo || image.live_photo_info || image.livePhotoVideo || image.live_photo_video ||
        image.livePhotoMedia || image.live_photo_media || image.motionPhoto || image.motion_photo ||
        image.motionPhotoInfo || image.motion_photo_info || image.videoInfo || image.video_info || image.video || image.stream;
      if (explicit && typeof explicit === "object") return explicit;
      if (image.isLivePhoto || image.is_live_photo || image.livePhoto === true || image.live_photo === true ||
        image.isMotionPhoto || image.is_motion_photo || image.mediaType === "live" || image.media_type === "live") return image;
      return videoUrls(image).length ? image : null;
    }
    imageList.forEach(function(image, index) {
      var info = imageInfo(image);
      if (liveValue(image) || liveSlidesByIndex[index + 1] || liveUrlsBySlide[index + 1]) info.live = true;
      if (info.url && !imageSeen.has(info.url)) { imageSeen.add(info.url); images.push(info); }
    });
    var videos = [], videoSeen = new Set();
    function addVideo(value, live, slideIndex) {
      var urls = videoUrls(value).filter(function(url) { return !videoSeen.has(url); });
      if (!urls.length) return;
      urls.forEach(function(url) { videoSeen.add(url); });
      videos.push({ url: urls[0], backupUrls: urls.slice(1), live: live === true, slideIndex: slideIndex || 0 });
    }
    var primaryVideoSource = note.video || note.videoInfo || note.video_info || note.media;
    var declaredVideoNote = /video/i.test(String(note.type || note.noteType || note.note_type || ""));
    if (!videoUrls(primaryVideoSource).length && declaredVideoNote && fallbackVideoUrls.length) {
      primaryVideoSource = fallbackVideoUrls;
    } else if (!videoUrls(primaryVideoSource).length && declaredVideoNote && document.querySelector) {
      var ogVideo = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
      if (ogVideo && ogVideo.content) primaryVideoSource = { videoUrl: ogVideo.content };
    }
    var hasPrimaryVideo = videoUrls(primaryVideoSource).length > 0;
    addVideo(primaryVideoSource, false);
    // 视频笔记的 imageList 仍可能带封面或视频字段；再遍历它会把封面和
    // 主视频同时加入队列。只有真正的图文笔记才提取 Live Photo 视频流。
    if (!hasPrimaryVideo) {
      imageList.forEach(function(image, index) {
        var live = liveValue(image), directUrls = videoUrls(live);
        addVideo(directUrls.length ? directUrls : liveUrlsBySlide[index + 1], true, index + 1);
      });
      var noteLive = note.livePhotoInfo || note.live_photo_info || note.livePhoto || note.live_photo ||
        note.livePhotoList || note.live_photo_list || note.motionPhotoList || note.motion_photo_list;
      if (Array.isArray(noteLive)) noteLive.forEach(function(item, index) { addVideo(item, true, index + 1); });
      else addVideo(noteLive, true);
      if (!videos.length && fallbackVideoUrls.length) {
        var liveIndex = 0;
        for (var liveImageIndex = 0; liveImageIndex < imageList.length; liveImageIndex++) {
          if (liveValue(imageList[liveImageIndex])) { liveIndex = liveImageIndex + 1; break; }
        }
        if (liveIndex) addVideo(fallbackVideoUrls, true, liveIndex);
      }
    }
    var payload = {
      noteId: id,
      title: note.title || note.displayTitle || note.desc || document.title || "小红书笔记",
      author: note.user && (note.user.nickname || note.user.nickName) || note.author && note.author.nickname || "",
      isVideo: hasPrimaryVideo,
      images: images,
      videos: videos
    };
    var signature = JSON.stringify(payload);
    if (signature === lastSignature) return;
    lastSignature = signature;
    document.documentElement.setAttribute("data-aesthetic-xhs-note", signature);
    document.dispatchEvent(new Event("aesthetic-xhs-note-ready"));
  }

  publish();
  setInterval(publish, 500);
  var pushState = history.pushState, replaceState = history.replaceState;
  history.pushState = function() { var result = pushState.apply(this, arguments); setTimeout(publish); return result; };
  history.replaceState = function() { var result = replaceState.apply(this, arguments); setTimeout(publish); return result; };
  addEventListener("popstate", function() { setTimeout(publish); });
})();
