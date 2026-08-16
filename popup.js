(function() {
  "use strict";

  // ── DOM 元素 ──────────────────────────────────
  var pageTypeEl = document.getElementById("pageType");
  var btnCollect = document.getElementById("btnCollect");
  var btnDownload = document.getElementById("btnDownload");
  var btnStop = document.getElementById("btnStop");
  var clearGroup = document.getElementById("clearGroup");
  var btnClearPending = document.getElementById("btnClearPending");
  var btnClearAll = document.getElementById("btnClearAll");
  var progressSection = document.getElementById("progressSection");
  var progressFill = document.getElementById("progressFill");
  var progressText = document.getElementById("progressText");
  var forceReset = document.getElementById("forceReset");
  var btnForceReset = document.getElementById("btnForceReset");
  var statsSection = document.getElementById("statsSection");
  var statImages = document.getElementById("statImages");
  var statBoards = document.getElementById("statBoards");
  var statDups = document.getElementById("statDups");
  var boardListSection = document.getElementById("boardListSection");
  var boardList = document.getElementById("boardList");
  var errorMsg = document.getElementById("errorMsg");
  var filterEnabled = document.getElementById("filterEnabled");
  var filterSummary = document.getElementById("filterSummary");
  var pluginEnabledInput = document.getElementById("pluginEnabled");
  var pluginStatusNote = document.getElementById("pluginStatusNote");
  var filterSection = document.getElementById("filterSection");
  var btnToggleWorkSelection = document.getElementById("btnToggleWorkSelection");

  var currentTabId = null;
  var isCollecting = false;
  var isDownloading = false;
  var currentPageType = null;
  var currentSite = "huaban";
  var pendingResumeFrom = -1; // 断点续传：-1=无续传，>=0=从第N批开始
  var currentFilterSettings = null;
  var pinterestAbort = false;
  var pluginEnabledState = true;
  var workSelectionEnabled = true;
  var lastSelectionUiSignature = "";

  var filterDefaults = {
    enabled: true, alphaRatio: 0.15,
    isolatedSubjectRatio: 0.70, adSuspiciousScore: 3, adRejectScore: 6,
    detectTransparency: true
  };

  function loadFilterSettings() {
    chrome.storage.local.get(["huaban_filter_settings"], function(data) {
      currentFilterSettings = Object.assign({}, filterDefaults, data.huaban_filter_settings || {});
      renderFilterSettings();
    });
  }

  function renderFilterSettings() {
    var s = currentFilterSettings || filterDefaults;
    filterEnabled.checked = !!s.enabled;
    if (!s.enabled) filterSummary.textContent = "过滤已关闭，所有图片按原插件规则采集";
  }

  function renderFilterStats(stats) {
    stats = stats || { accepted: 0, suspicious: 0, rejected: 0, manualExcluded: 0, reasons: {} };
    filterSummary.innerHTML = '<span class="filter-stat"><i class="filter-dot filter-dot-normal"></i>正常 ' + (stats.accepted || 0) + '</span>' +
      '<span class="filter-stat"><i class="filter-dot filter-dot-suspicious"></i>疑似 ' + (stats.suspicious || 0) + '</span>' +
      '<span class="filter-stat"><i class="filter-dot filter-dot-rejected"></i>排除 ' + (stats.rejected || 0) + '</span>' +
      '<span class="filter-stat"><i class="filter-dot filter-dot-manual"></i>手动排除 ' + (stats.manualExcluded || 0) + '</span>';
  }

  loadFilterSettings();

  function renderPluginState() {
    pluginEnabledInput.checked = pluginEnabledState;
    pluginStatusNote.textContent = pluginEnabledState ? "已开启：正在识别并采集图片" : "已关闭：页面选框和采集已停止";
    filterSection.classList.toggle("is-disabled", !pluginEnabledState);
    filterEnabled.disabled = !pluginEnabledState;
    if (!pluginEnabledState) { btnToggleWorkSelection.style.display = "none"; showUnsupported("插件已关闭"); }
  }

  chrome.storage.local.get(["aesthetic_collector_enabled"], function(data) {
    pluginEnabledState = data.aesthetic_collector_enabled !== false;
    renderPluginState();
  });

  // ── 右侧栏页面绑定 ────────────────────────────
  // 侧栏会长期存在，必须在活动标签或 SPA 路由变化后重新绑定目标页面。
  function bindActiveTab(restoreTask) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    var tab = tabs[0];
    if (!tab) { showUnsupported("无法获取当前标签页"); return; }
    currentTabId = tab.id;

    if (!tab.url || (tab.url.indexOf("huaban.com") === -1 && tab.url.indexOf("pinterest.com") === -1 && tab.url.indexOf("zcool.com.cn") === -1 && tab.url.indexOf("xiaohongshu.com") === -1 && tab.url.indexOf("behance.net") === -1)) {
      showUnsupported("请在花瓣、Pinterest、站酷、小红书或 Behance 页面使用");
      return;
    }

    chrome.runtime.sendMessage({ action: "GET_TASK_STATE" }, function(taskState) {
      if (chrome.runtime.lastError) taskState = { status: "idle" };

      chrome.tabs.sendMessage(currentTabId, { action: "DETECT_PAGE" }, function(resp) {
        if (chrome.runtime.lastError || !resp) {
          showUnsupported("请刷新当前网页后重试");
          return;
        }

        currentPageType = resp.pageType;
        currentSite = resp.site || (tab.url.indexOf("pinterest.com") !== -1 ? "pinterest" : tab.url.indexOf("zcool.com.cn") !== -1 ? "zcool" : tab.url.indexOf("xiaohongshu.com") !== -1 ? "xiaohongshu" : tab.url.indexOf("behance.net") !== -1 ? "behance" : "huaban");
        errorMsg.style.display = "none";
        if (currentSite === "pinterest") {
          var pinterestType = ({ search: "搜索页", board: "画板", pin: "Pin 详情页", home: "首页瀑布流" })[resp.pageType] || "Pinterest";
          pageTypeEl.textContent = "Pinterest · " + pinterestType;
          if (resp.pageTitle) pageTypeEl.textContent += " · " + resp.pageTitle;
        } else if (currentSite === "zcool") {
          var zcoolType = ({ search: "搜索页", collection: "收藏夹", work: "作品详情页", home: "推荐页" })[resp.pageType] || "作品列表";
          pageTypeEl.textContent = "站酷 · " + zcoolType;
          if (resp.pageTitle) pageTypeEl.textContent += " · " + resp.pageTitle;
        } else if (currentSite === "xiaohongshu") {
          pageTypeEl.textContent = "小红书 · " + (resp.pageType === "note" ? "笔记详情页" : "首页/列表页");
          if (resp.pageTitle && resp.pageType === "note") pageTypeEl.textContent += " · " + resp.pageTitle;
          if (resp.filterStats) renderFilterStats(resp.filterStats);
          if (resp.pageType === "note") {
            workSelectionEnabled = (resp.selected || 0) > 0;
            btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
          }
        } else if (currentSite === "behance") {
          pageTypeEl.textContent = "Behance · " + (resp.pageType === "project" ? "项目详情页" : "列表页");
          if (resp.pageTitle && resp.pageType === "project") pageTypeEl.textContent += " · " + resp.pageTitle;
          if (resp.pageType === "project") {
            workSelectionEnabled = (resp.selected || 0) > 0;
            btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
          }
        } else if (resp.pageType === "board") {
          pageTypeEl.textContent = "当前页面：画板";
          if (resp.boardTitle) {
            pageTypeEl.textContent += " - " + resp.boardTitle;
          }
        } else if (resp.pageType === "search") {
          pageTypeEl.textContent = "当前页面：搜索结果页";
        } else if (resp.pageType === "pin") {
          pageTypeEl.textContent = "当前页面：Pin 详情页";
          if (resp.recommendedCount > 0) {
            pageTypeEl.textContent += " + " + resp.recommendedCount + " 个推荐";
          }
        } else {
          showUnsupported("请在花瓣网画板、搜索页或 Pin 页使用");
          return;
        }

        if (restoreTask !== false) restoreTaskState(taskState, resp.pageType);
        else if (!isCollecting && !isDownloading) showReadyForPageType(resp.pageType);
      });
    });

    // 加载已有统计
    refreshStats();
  });
  }

  bindActiveTab(true);
  chrome.tabs.onActivated.addListener(function() { bindActiveTab(false); });
  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (tabId !== currentTabId || (!changeInfo.url && changeInfo.status !== "complete")) return;
    if (tab.active) setTimeout(function() { bindActiveTab(false); }, changeInfo.status === "complete" ? 200 : 900);
  });

  // ── 恢复任务状态 ──────────────────────────────
  function restoreTaskState(task, pageType) {
    if (!task || task.status === "idle") {
      showReadyForPageType(pageType);
      return;
    }

    if (task.status === "collecting") {
      isCollecting = true;
      btnCollect.textContent = "采集中...";
      btnCollect.disabled = true;
      btnCollect.className = "btn btn-gray";
      btnCollect.style.display = "block";
      btnDownload.style.display = "none";
      showStopButton("采集");
      progressSection.style.display = "block";
      forceReset.style.display = "block";
      if (task.total > 0) {
        var pct = Math.round((task.current / task.total) * 100);
        progressFill.style.width = pct + "%";
        progressText.textContent = "采集 Pin " + task.current + " / " + task.total;
      } else {
        progressText.textContent = "正在采集...";
      }
      return;
    }

    if (task.status === "collect_done") {
      progressSection.style.display = "block";
      progressFill.style.width = "100%";
      progressText.textContent = "采集完成！新增 " + (task.added || 0) + " 张" +
        (task.skipped > 0 ? "，跳过 " + task.skipped + " 张重复" : "");
      showReadyForPageType(pageType);
      return;
    }

    if (task.status === "downloading" || task.status === "zipping") {
      // 侧栏重新载入后，不可能仍有旧页面内的文件整理任务在运行。
      // 自动清理旧版遗留的 100% 卡死状态。
      if (task.status === "zipping" && (!task.updatedAt || Date.now() - task.updatedAt > 2000)) {
        chrome.runtime.sendMessage({ action: "FORCE_RESET" }, function() {
          showReadyForPageType(pageType);
          refreshStats();
        });
        return;
      }
      chrome.storage.local.get(["huaban_dl_tabId"], function(data) {
        var dlTabId = data.huaban_dl_tabId;
        if (dlTabId && dlTabId !== currentTabId) {
          chrome.tabs.get(dlTabId, function(dlTab) {
            if (chrome.runtime.lastError || !dlTab) {
              progressSection.style.display = "block";
              progressFill.style.width = "0%";
              progressText.textContent = "下载标签页已关闭，可在当前页继续";
              pendingResumeFrom = task.completedBatches || 0;
              btnDownload.style.display = "block";
              btnDownload.textContent = "\u25B6 继续下载";
              btnDownload.disabled = false;
              btnDownload.className = "btn btn-green";
              showReadyForPageType(pageType);
            } else {
              progressSection.style.display = "block";
              progressFill.style.width = "50%";
              progressText.textContent = "下载正在另一个标签页进行中...";
              forceReset.style.display = "block";
              btnCollect.disabled = true;
              btnCollect.textContent = "下载进行中";
              btnCollect.className = "btn btn-gray";
            }
          });
        } else {
          if (task.status === "downloading") {
            isDownloading = true;
            btnDownload.style.display = "block";
            btnDownload.textContent = "下载中...";
            btnDownload.disabled = true;
            btnDownload.className = "btn btn-gray";
            btnCollect.style.display = "none";
            showStopButton("下载");
            progressSection.style.display = "block";
            forceReset.style.display = "block";
            if (task.total > 0) {
              var dlPct = Math.round((task.current / task.total) * 100);
              progressFill.style.width = dlPct + "%";
              progressText.textContent = "下载图片 " + task.current + " / " + task.total +
                " (成功 " + (task.ok || 0) + " / 失败 " + (task.fail || 0) + ")";
            } else {
              progressText.textContent = "准备下载...";
            }
          } else {
            isDownloading = true;
            btnDownload.style.display = "block";
            btnDownload.textContent = "整理文件中...";
            btnDownload.disabled = true;
            btnDownload.className = "btn btn-gray";
            btnCollect.style.display = "none";
            btnStop.style.display = "none";
            progressSection.style.display = "block";
            forceReset.style.display = "block";
            var zipPct = task.percent || 0;
            progressFill.style.width = zipPct + "%";
            progressText.textContent = "正在整理文件... " + zipPct + "%";
          }
        }
      });
      return;
    }

    if (task.status === "paused") {
      progressSection.style.display = "block";
      var done = task.completedBatches || 0;
      var total = task.totalBatches || 0;
      var pct = task.total > 0 ? Math.round((task.processed / task.total) * 100) : 0;
      progressFill.style.width = pct + "%";
      var info = "下载已暂停";
      if (total > 1) {
        info += "（已完成 " + done + "/" + total + " 批）";
      }
      progressText.textContent = info;

      pendingResumeFrom = done;
      btnDownload.style.display = "block";
      btnDownload.textContent = "\u25B6 继续下载";
      btnDownload.disabled = false;
      btnDownload.className = "btn btn-green";
      showReadyForPageType(pageType);
      return;
    }

    if (task.status === "dl_done") {
      progressSection.style.display = "block";
      progressFill.style.width = "100%";
      progressText.textContent = "下载完成！" + (task.ok || 0) + " 个文件";
      showReadyForPageType(pageType);
      chrome.runtime.sendMessage({ action: "GET_STATS" });
      return;
    }

    pendingResumeFrom = -1;
    showReadyForPageType(pageType);
  }

  // ── UI 状态函数 ────────────────────────────────
  function showUnsupported(msg) {
    btnCollect.textContent = msg;
    btnCollect.disabled = true;
    btnCollect.className = "btn btn-gray";
  }

  function showReadyForPageType(pageType) {
    if (!pluginEnabledState) { showUnsupported("插件已关闭"); return; }
    btnToggleWorkSelection.style.display = "none";
    if (currentSite === "pinterest") {
      showReady(pageType === "pin" ? "采集本页图片" : "加入待下载");
    } else if (currentSite === "zcool") {
      if (pageType === "work") { showReady("加入待下载"); btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片"; btnToggleWorkSelection.style.display = "block"; }
      else showUnsupported("请进入作品详情页采集");
    } else if (currentSite === "xiaohongshu") {
      if (pageType === "note") {
        showReady("加入待下载");
        btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
        btnToggleWorkSelection.style.display = "block";
      }
      else showUnsupported("请点开具体小红书笔记后采集");
    } else if (currentSite === "behance") {
      if (pageType === "project") {
        showReady("加入待下载");
        btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
        btnToggleWorkSelection.style.display = "block";
      } else showUnsupported("请进入 Behance 项目详情页采集");
    } else if (pageType === "board") {
      showReady("采集画板图片");
    } else if (pageType === "search") {
      showReady("加入待下载");
    } else if (pageType === "pin") {
      showReady("采集本页 + 推荐图片");
    } else {
      showReady("采集图片");
    }
  }

  function showReady(text) {
    btnCollect.textContent = text;
    btnCollect.disabled = false;
    btnCollect.className = "btn btn-primary";
    btnCollect.style.display = "block";
    btnStop.style.display = "none";
    forceReset.style.display = "none";
    isCollecting = false;
    isDownloading = false;
  }

  btnToggleWorkSelection.addEventListener("click", function() {
    var isZcoolWork = currentSite === "zcool" && currentPageType === "work";
    var isXhsNote = currentSite === "xiaohongshu" && currentPageType === "note";
    var isBehanceProject = currentSite === "behance" && currentPageType === "project";
    if (!currentTabId || (!isZcoolWork && !isXhsNote && !isBehanceProject)) return;
    workSelectionEnabled = !workSelectionEnabled;
    chrome.tabs.sendMessage(currentTabId, { action: "SET_WORK_SELECTION", selected: workSelectionEnabled }, function(resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      var subject = isXhsNote ? "本笔记" : "本作品";
      btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
      if (workSelectionEnabled) {
        errorMsg.style.display = "none";
        showReady("加入待下载");
        return;
      }
      btnCollect.textContent = subject + "已取消选择";
      btnCollect.disabled = true;
      btnCollect.className = "btn btn-gray";
      chrome.runtime.sendMessage({ action: "REMOVE_BOARD_IMAGES", boardId: resp.boardId }, function(result) {
        if (chrome.runtime.lastError || !result || !result.ok) {
          showError("已取消页面选择，但从待下载移除失败，请重试");
          return;
        }
        errorMsg.style.display = "none";
        progressSection.style.display = "block";
        progressFill.style.width = "100%";
        progressText.textContent = result.removed > 0
          ? "已取消" + subject + "，并从待下载移除 " + result.removed + " 项"
          : "已取消" + subject + "；待下载中没有对应内容";
        refreshStats();
      });
    });
  });

  function showCollecting() {
    isCollecting = true;
    btnCollect.textContent = "采集中...";
    btnCollect.disabled = true;
    btnCollect.className = "btn btn-gray";
    btnCollect.style.display = "block";
    btnDownload.style.display = "none";
    showStopButton("采集");
    progressSection.style.display = "block";
    progressFill.style.width = "0%";
    progressText.textContent = "正在加载 Pin 数据...";
    forceReset.style.display = "block";
    errorMsg.style.display = "none";
  }

  function showDownloading() {
    isDownloading = true;
    btnDownload.textContent = "下载中...";
    btnDownload.disabled = true;
    btnDownload.className = "btn btn-gray";
    btnCollect.style.display = "none";
    showStopButton("下载");
    progressSection.style.display = "block";
    progressFill.style.width = "0%";
    progressText.textContent = "准备下载...";
    forceReset.style.display = "block";
  }

  function showStopButton(label) {
    btnStop.textContent = "\u23F9 停止" + label;
    btnStop.style.display = "block";
    btnStop.disabled = false;
    btnStop.className = "btn btn-red";
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = "block";
  }

  function resetUI() {
    isCollecting = false;
    isDownloading = false;
    pendingResumeFrom = -1;
    btnStop.style.display = "none";
    forceReset.style.display = "none";
    errorMsg.style.display = "none";
    btnCollect.style.display = "block";
    showReadyForPageType(currentPageType || "board");
    refreshStats();
  }

  function refreshStats() {
    chrome.runtime.sendMessage({ action: "GET_STATS" }, function(stats) {
      if (chrome.runtime.lastError || !stats) return;

      var hasPending = stats.imageCount > 0;
      var hasHistory = stats.downloadedCount > 0;

      if (hasPending || hasHistory) {
        statsSection.style.display = "flex";
        statImages.textContent = stats.imageCount;
        statBoards.textContent = stats.boardCount;
        statDups.textContent = stats.skippedDups;

        if (hasPending && !isCollecting) {
          btnDownload.style.display = "block";
          if (!isDownloading && pendingResumeFrom < 0) {
            btnDownload.textContent = "下载 " + stats.imageCount + " 项到本地";
            btnDownload.disabled = false;
            btnDownload.className = "btn btn-download";
          }
        } else if ((!hasPending || isCollecting) && !isDownloading && pendingResumeFrom < 0) {
          btnDownload.style.display = "none";
        }

        clearGroup.style.display = "flex";
        btnClearPending.style.display = hasPending ? "block" : "none";
        btnClearAll.style.display = hasHistory ? "block" : "none";

        if (stats.boards && stats.boards.length > 0) {
          boardListSection.style.display = "block";
          boardList.innerHTML = "";
          stats.boards.forEach(function(b) {
            var item = document.createElement("div");
            item.className = "work-item";
            item.innerHTML =
              '<span class="work-item-title" title="' + escapeHtml(b.sourceUrl || b.title) + '">' +
              escapeHtml(b.title) + '</span>' +
              '<span class="work-item-count">' + b.pinCount + ' 张</span>';
            if (b.sourceUrl) item.addEventListener("click", function() { chrome.tabs.create({ url: b.sourceUrl }); });
            boardList.appendChild(item);
          });
        } else {
          boardListSection.style.display = "none";
        }
      } else {
        statsSection.style.display = "none";
        btnDownload.style.display = "none";
        clearGroup.style.display = "none";
        boardListSection.style.display = "none";
      }
    });
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── 按钮事件 ──────────────────────────────────

  filterEnabled.addEventListener("change", function() {
    currentFilterSettings = Object.assign({}, currentFilterSettings || filterDefaults, { enabled: filterEnabled.checked });
    chrome.storage.local.set({ huaban_filter_settings: currentFilterSettings }, function() {
      if (currentTabId) chrome.tabs.sendMessage(currentTabId, { action: "UPDATE_FILTER_SETTINGS", settings: currentFilterSettings });
      renderFilterSettings();
    });
  });

  pluginEnabledInput.addEventListener("change", function() {
    pluginEnabledState = pluginEnabledInput.checked;
    chrome.storage.local.set({ aesthetic_collector_enabled: pluginEnabledState }, function() {
      if (currentTabId) chrome.tabs.sendMessage(currentTabId, { action: "UPDATE_PLUGIN_ENABLED", enabled: pluginEnabledState });
      renderPluginState();
      if (pluginEnabledState) bindActiveTab(false);
    });
  });


  btnCollect.addEventListener("click", function() {
    if (!pluginEnabledState || isCollecting || isDownloading || !currentTabId) return;
    showCollecting();
    chrome.tabs.sendMessage(currentTabId, { action: "COLLECT" }, function(resp) {
      if (chrome.runtime.lastError || !resp) {
        showError("无法连接到页面，请刷新后重试");
        showReadyForPageType(currentPageType);
      }
    });
  });

  btnDownload.addEventListener("click", function() {
    if (isDownloading || !currentTabId) return;
    showDownloading();
    // 下载属于跨平台全局队列，不再由当前网站决定执行路径。
    downloadCombinedQueue();
  });

  btnStop.addEventListener("click", function() {
    if (!currentTabId) return;
    if (isDownloading) pinterestAbort = true;
    btnStop.textContent = "正在停止...";
    btnStop.disabled = true;
    btnStop.className = "btn btn-gray";
    chrome.tabs.sendMessage(currentTabId, { action: "ABORT" }, function() {
      if (chrome.runtime.lastError) {
        forceResetTask();
      }
    });
  });

  function pinterestSafeName(value) {
    return String(value || "Pinterest").replace(/^(Pinterest|搜索):\s*/i, "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "Pinterest";
  }

  function pinterestDate() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }

  function originalImageName(image) {
    if (/^xiaohongshu:/i.test(String(image.pin_id || ""))) {
      return pinterestSafeName(image.exportName || image.text || "小红书笔记");
    }
    if (/^zcool:/i.test(String(image.pin_id || ""))) {
      return pinterestSafeName(image.exportName || String(image.text || "").replace(/[\uFF08(]\s*\u56FE[^\uFF09)]*[\uFF09)]\s*$/i, "") || "\u7AD9\u9177\u4F5C\u54C1");
    }
    if (/^behance:/i.test(String(image.pin_id || ""))) {
      return pinterestSafeName(image.exportName || image.text || "Behance 项目");
    }
    var source = String(image.url || image.fileKey || image.pin_id || "image").split("?")[0].split("#")[0];
    var name = source.substring(source.lastIndexOf("/") + 1);
    try { name = decodeURIComponent(name); } catch (_error) { /* 保留原值 */ }
    name = name.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
    return pinterestSafeName(name || image.pin_id || "image");
  }

  function imageSourceLabel(image) {
    var id = String(image.pin_id || "");
    if (/^zcool:/i.test(id)) return "站酷";
    if (/^pinterest:/i.test(id)) return "Pinterest";
    if (/^xiaohongshu:/i.test(id)) return "小红书";
    if (/^behance:/i.test(id)) return "Behance";
    return "花瓣";
  }

  function exportImageName(sequence, image, extension) {
    return String(sequence).padStart(4, "0") + "-" + pinterestDate() + "-" +
      imageSourceLabel(image) + "-" + originalImageName(image) + extension;
  }

  async function pinterestHash(blob) {
    var bitmap;
    try { bitmap = await createImageBitmap(blob, { resizeWidth: 16, resizeHeight: 8, resizeQuality: "low" }); }
    catch (_resizeError) { bitmap = await createImageBitmap(blob); }
    var canvas = new OffscreenCanvas(16, 8), ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 16, 8); if (bitmap.close) bitmap.close();
    var data = ctx.getImageData(0, 0, 16, 8).data, hash = "";
    for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
      var a = (y * 16 + x) * 4, b = (y * 16 + x + 1) * 4;
      hash += data[a] + data[a + 1] + data[a + 2] > data[b] + data[b + 1] + data[b + 2] ? "1" : "0";
    }
    return hash;
  }

  function hashDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 999;
    var distance = 0; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
    return distance;
  }

  function normalizeImageUrl(image, useFallback) {
    var value = String((useFallback ? image.fileKey : image.url) || "");
    if (/^https?:\/\//i.test(value)) return value;
    if (!value) return "";
    return "https://gd-hbimg-edge.huaban.com/" + value.replace(/^\/+/, "");
  }

  function queueMediaUrls(image) {
    var values = [normalizeImageUrl(image, false)].concat(Array.isArray(image.backupUrls) ? image.backupUrls : []);
    if (image.fileKey) values.push(normalizeImageUrl(image, true));
    var seen = new Set();
    return values.filter(function(value) {
      value = String(value || "");
      if (!/^https?:\/\//i.test(value) || seen.has(value)) return false;
      seen.add(value); return true;
    });
  }

  function resolveVimeoMedia(image) {
    return new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage({ action: "RESOLVE_VIMEO", playerUrl: image.url }, function(result) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!result || !result.ok) { reject(new Error(result && result.error || "Vimeo 解析失败")); return; }
        resolve(Object.assign({}, image, { url: result.url, fileKey: "", backupUrls: result.backupUrls || [],
          fileType: result.fileType || "video/mp4", mediaType: "video",
          vimeoStreamType: result.streamType || "progressive",
          width: result.width || image.width, height: result.height || image.height }));
      });
    });
  }

  function hlsAttributes(value) {
    var output = {}, pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi, match;
    while ((match = pattern.exec(String(value || "")))) output[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
    return output;
  }

  function hlsUrl(value, base) {
    try { return new URL(String(value || ""), base).href; } catch (_error) { return ""; }
  }

  function hlsVariants(text, base) {
    var lines = String(text || "").split(/\r?\n/), output = [];
    for (var index = 0; index < lines.length; index++) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
      var attrs = hlsAttributes(lines[index].slice(lines[index].indexOf(":") + 1)), next = index + 1;
      while (next < lines.length && (!lines[next].trim() || /^#/.test(lines[next]))) next++;
      var url = next < lines.length ? hlsUrl(lines[next].trim(), base) : "";
      if (url) output.push({ url: url, bandwidth: Number(attrs.BANDWIDTH) || 0 });
    }
    return output.sort(function(a, b) { return b.bandwidth - a.bandwidth; });
  }

  function hlsMediaParts(text, base) {
    if (/#EXT-X-KEY:METHOD=(?!NONE)/i.test(text)) throw new Error("Vimeo HLS 分片已加密，无法直接合并");
    var lines = String(text || "").split(/\r?\n/), output = [], pendingRange = "", previousEnds = {};
    lines.forEach(function(rawLine) {
      var line = rawLine.trim();
      if (/^#EXT-X-MAP:/i.test(line)) {
        var attrs = hlsAttributes(line.slice(line.indexOf(":") + 1));
        if (attrs.URI) {
          var mapRange = "", mapBits = String(attrs.BYTERANGE || "").split("@");
          if (mapBits[0]) {
            var mapLength = Number(mapBits[0]) || 0, mapStart = Number(mapBits[1]) || 0;
            if (mapLength > 0) mapRange = mapStart + "-" + (mapStart + mapLength - 1);
          }
          output.push({ url: hlsUrl(attrs.URI, base), range: mapRange });
        }
      } else if (/^#EXT-X-BYTERANGE:/i.test(line)) {
        pendingRange = line.slice(line.indexOf(":") + 1).trim();
      } else if (line && !/^#/.test(line)) {
        var url = hlsUrl(line, base), range = pendingRange; pendingRange = "";
        if (!url) return;
        if (range) {
          var bits = range.split("@"), length = Number(bits[0]) || 0;
          var start = bits.length > 1 ? Number(bits[1]) || 0 : previousEnds[url] || 0;
          previousEnds[url] = start + length;
          range = length > 0 ? start + "-" + (start + length - 1) : "";
        }
        output.push({ url: url, range: range });
      }
    });
    return output;
  }

  async function fetchHlsText(url) {
    var response = await fetch(url, { credentials: "omit", cache: "no-store",
      referrer: "https://player.vimeo.com/", referrerPolicy: "strict-origin-when-cross-origin" });
    if (!response.ok) throw new Error("HLS HTTP " + response.status);
    return response.text();
  }

  async function fetchHlsPart(part) {
    var headers = part.range ? { Range: "bytes=" + part.range } : {};
    var response = await fetch(part.url, { credentials: "omit", cache: "no-store", headers: headers,
      referrer: "https://player.vimeo.com/", referrerPolicy: "strict-origin-when-cross-origin" });
    if (!response.ok) throw new Error("HLS 分片 HTTP " + response.status);
    return response.arrayBuffer();
  }

  async function fetchVimeoHls(image) {
    var playlistUrls = queueMediaUrls(image), lastError = null;
    for (var sourceIndex = 0; sourceIndex < playlistUrls.length; sourceIndex++) {
      try {
        var playlistUrl = playlistUrls[sourceIndex], text = await fetchHlsText(playlistUrl);
        var variants = hlsVariants(text, playlistUrl);
        if (variants.length) { playlistUrl = variants[0].url; text = await fetchHlsText(playlistUrl); }
        var parts = hlsMediaParts(text, playlistUrl);
        if (!parts.length) throw new Error("HLS 播放列表没有视频分片");
        var buffers = new Array(parts.length), completed = 0;
        for (var offset = 0; offset < parts.length; offset += 6) {
          var batch = parts.slice(offset, offset + 6);
          var values = await Promise.all(batch.map(fetchHlsPart));
          values.forEach(function(value, batchIndex) { buffers[offset + batchIndex] = value; });
          completed += values.length;
          var percent = Math.round(completed / parts.length * 100);
          progressFill.style.width = percent + "%";
          progressText.textContent = "正在下载 Vimeo 视频... " + percent + "%";
        }
        var first = new Uint8Array(buffers[0] || new ArrayBuffer(0));
        var isFragmentedMp4 = first.length >= 8 && String.fromCharCode(first[4], first[5], first[6], first[7]) === "ftyp";
        if (!isFragmentedMp4) throw new Error("Vimeo HLS 不是可直接合并的 fMP4 视频");
        return { blob: new Blob(buffers, { type: "video/mp4" }), kind: "video", isVideo: true, sourceUrl: playlistUrl };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error("Vimeo HLS 下载失败");
  }

  async function fetchQueueMedia(image) {
    if (image.isVimeo === true) image = await resolveVimeoMedia(image);
    if (image.vimeoStreamType === "hls") return fetchVimeoHls(image);
    var declaredVideo = /^video\//i.test(image.fileType || "") || image.mediaType === "video";
    var urls = queueMediaUrls(image), lastReason = "没有可用媒体地址";
    for (var index = 0; index < urls.length; index++) {
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timeout = controller ? setTimeout(function() { controller.abort(); }, 20000) : null;
      try {
        var mediaReferrer = /^behance:/i.test(String(image.pin_id || "")) ? "https://www.behance.net/" : "https://www.xiaohongshu.com/";
        var response = await fetch(urls[index], { credentials: "omit", referrer: mediaReferrer,
          referrerPolicy: "strict-origin-when-cross-origin", signal: controller && controller.signal });
        if (!response.ok) { lastReason = "HTTP " + response.status; continue; }
        var blob = await response.blob();
        var kind = await window.AestheticMediaUtils.sniffBlobKind(blob);
        if (declaredVideo && kind !== "video") {
          lastReason = "平台返回的是静态封面，不是真实视频流";
          continue;
        }
        return { blob: blob, kind: kind, isVideo: kind === "video", sourceUrl: urls[index] };
      } catch (error) {
        lastReason = error && error.name === "AbortError" ? "请求超时" : error && error.message || "媒体请求失败";
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw new Error(declaredVideo ? "未取得真实视频流：" + lastReason : lastReason);
  }

  function gifCanvasSize(width, height) {
    var scale = Math.min(1, 540 / Math.max(width || 1, height || 1));
    return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
  }

  async function animatedImageToGif(blob) {
    if (!/^image\/(?:webp|avif)$/i.test(blob.type) || typeof ImageDecoder === "undefined" || !window.AestheticGifEncoder) return null;
    var decoder;
    try {
      decoder = new ImageDecoder({ data: blob.stream(), type: blob.type });
      await decoder.tracks.ready;
      var track = decoder.tracks.selectedTrack;
      if (!track || track.frameCount < 2) { decoder.close(); return null; }
      var total = Math.min(track.frameCount, 48), frames = [], canvas = null, ctx = null, size = null;
      for (var i = 0; i < total; i++) {
        var decoded = await decoder.decode({ frameIndex: i });
        var frame = decoded.image;
        if (!size) {
          size = gifCanvasSize(frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
          canvas = new OffscreenCanvas(size.width, size.height); ctx = canvas.getContext("2d", { willReadFrequently: true });
        }
        ctx.clearRect(0, 0, size.width, size.height);
        ctx.drawImage(frame, 0, 0, size.width, size.height);
        frames.push({ rgba: new Uint8Array(ctx.getImageData(0, 0, size.width, size.height).data),
          delayCs: Math.max(2, Math.round((frame.duration || 100000) / 10000)) });
        frame.close();
        if (i % 6 === 5) await new Promise(function(resolve) { setTimeout(resolve, 0); });
      }
      decoder.close();
      return window.AestheticGifEncoder.encode(size.width, size.height, frames);
    } catch (_error) {
      if (decoder) try { decoder.close(); } catch (_closeError) {}
      return null;
    }
  }

  function finishLocalDownload(msg) {
    progressFill.style.width = "100%";
    var doneText = "下载完成！" + msg.ok + " 个文件";
    if (msg.visualDuplicates > 0) doneText += "，视觉重复跳过 " + msg.visualDuplicates + " 张";
    if (msg.fail > 0) doneText += "；失败 " + msg.fail + " 张已保留，可重新下载";
    progressText.textContent = doneText;
    resetUI();
    refreshStats();
    setTimeout(refreshStats, 500);
  }

  async function downloadCombinedQueue() {
    pinterestAbort = false;
    chrome.runtime.sendMessage({ action: "GET_DOWNLOAD_DATA" }, async function(data) {
      var images = (data && data.images || []);
      if (!images.length) {
        chrome.runtime.sendMessage({ action: "DL_ERROR" });
        showError("没有可下载的图片");
        resetUI();
        return;
      }
      var zip = new JSZip(), failedIds = [], reasons = {}, hashes = [], ok = 0, visualDuplicates = 0;
      for (var i = 0; i < images.length && !pinterestAbort; i++) {
        try {
          var fetchedMedia = await fetchQueueMedia(images[i]);
          var blob = fetchedMedia.blob, isVideo = fetchedMedia.isVideo;
          if (isVideo) {
            ok++;
            var videoExt = window.AestheticMediaUtils.videoExtension(blob, fetchedMedia.sourceUrl);
            zip.file(exportImageName(ok, images[i], videoExt), blob, { compression: "STORE" });
          } else {
            var hash = await pinterestHash(blob);
            if (hashes.some(function(existing) { return hashDistance(hash, existing) <= 2; })) { visualDuplicates++; }
            else {
              hashes.push(hash); ok++;
              var animatedGif = await animatedImageToGif(blob);
              if (animatedGif) blob = animatedGif;
              var ext = /gif/i.test(blob.type) ? ".gif" : /png/i.test(blob.type) ? ".png" : /webp/i.test(blob.type) ? ".webp" : ".jpg";
              // JPG/PNG/WebP/GIF 本身已经压缩，STORE 可避免 Behance 超长大图在打包阶段长时间假死。
              zip.file(exportImageName(ok, images[i], ext), blob, { compression: "STORE" });
            }
          }
        } catch (error) {
          failedIds.push(images[i].pin_id);
          var reason = error && error.message || "网络或图片解码失败";
          reasons[reason] = (reasons[reason] || 0) + 1;
        }
        chrome.runtime.sendMessage({ action: "DL_PROGRESS", current: i + 1, total: images.length, ok: ok, fail: failedIds.length, batch: 1, totalBatches: 1 });
      }
      if (pinterestAbort) {
        chrome.runtime.sendMessage({ action: "FORCE_RESET" });
        resetUI(); refreshStats(); return;
      }
      if (!ok) {
        chrome.runtime.sendMessage({ action: "DL_ERROR" });
        showError("下载失败：" + Object.keys(reasons).join("、")); resetUI(); return;
      }
      chrome.runtime.sendMessage({ action: "DL_ZIPPING", percent: 0 });
      var zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } }, function(meta) {
        progressFill.style.width = Math.round(meta.percent) + "%";
        progressText.textContent = "正在打包 ZIP... " + Math.round(meta.percent) + "%";
      });
      var filename = "审美图-" + pinterestDate() + "-" + ok + "个文件.zip";
      var blobUrl = URL.createObjectURL(zipBlob);
      chrome.runtime.sendMessage({ action: "TRIGGER_DOWNLOAD", blobUrl: blobUrl, filename: filename, saveAs: true }, function(downloadResult) {
        setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 60000);
        if (!downloadResult || !downloadResult.ok) {
          chrome.runtime.sendMessage({ action: "DL_ERROR" });
          showError("浏览器未能保存 ZIP：" + (downloadResult && downloadResult.error || "未知错误"));
          resetUI();
          return;
        }
        var doneMessage = { action: "DL_DONE", ok: ok, fail: failedIds.length, failedPinIds: failedIds,
          failureReasons: reasons, visualDuplicates: visualDuplicates, batches: 1, filename: filename };
        chrome.runtime.sendMessage(doneMessage, function(result) {
          if (!result || !result.ok) { showError("ZIP 已保存，但更新队列失败，请点击强制重置"); return; }
          finishLocalDownload(doneMessage);
        });
      });
    });
  }

  btnForceReset.addEventListener("click", function(e) {
    e.preventDefault();
    forceResetTask();
  });

  function forceResetTask() {
    chrome.runtime.sendMessage({ action: "FORCE_RESET" }, function() {
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { action: "ABORT" }, function() {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
      progressSection.style.display = "none";
      resetUI();
    });
  }

  btnClearPending.addEventListener("click", function() {
    if (isCollecting || isDownloading) return;
    if (!confirm("清空待下载列表？已下载的去重记录会保留。")) return;
    chrome.runtime.sendMessage({ action: "CLEAR_PENDING" }, function() {
      refreshStats();
      progressSection.style.display = "none";
    });
  });

  btnClearAll.addEventListener("click", function() {
    if (isCollecting || isDownloading) return;
    if (!confirm("完全重置？将清除所有数据，包括已下载的去重记录。之后采集的图片不再跟历史去重。")) return;
    chrome.runtime.sendMessage({ action: "CLEAR_ALL" }, function() {
      refreshStats();
      progressSection.style.display = "none";
    });
  });

  // ── 消息监听 ──────────────────────────────────
  chrome.runtime.onMessage.addListener(function(msg) {

    if (msg.action === "SELECTION_COUNT") {
      var uiSignature = [currentSite, currentPageType, msg.selected, msg.total,
        msg.filterStats && msg.filterStats.accepted, msg.filterStats && msg.filterStats.suspicious,
        msg.filterStats && msg.filterStats.rejected, msg.filterStats && msg.filterStats.manualExcluded].join(":");
      if (uiSignature === lastSelectionUiSignature) return;
      lastSelectionUiSignature = uiSignature;
      if (msg.filterStats) renderFilterStats(msg.filterStats);
      if (currentSite === "pinterest") {
        pageTypeEl.textContent = "Pinterest：已选 " + msg.selected + " / " + msg.total + " 个 Pin";
      } else if (currentSite === "zcool") {
        if (currentPageType === "work") {
          pageTypeEl.textContent = "站酷作品：已选 " + msg.selected + " / " + msg.total + " 项媒体";
          workSelectionEnabled = msg.selected > 0;
          btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
          if (!workSelectionEnabled && !isCollecting && !isDownloading) {
            btnCollect.textContent = "本作品已取消选择";
            btnCollect.disabled = true;
            btnCollect.className = "btn btn-gray";
          } else if (workSelectionEnabled && !isCollecting && !isDownloading) {
            showReady("加入待下载");
          }
        }
      } else if (currentSite === "xiaohongshu") {
        if (currentPageType === "note") {
          pageTypeEl.textContent = "小红书笔记：已选 " + msg.selected + " / " + msg.total + " 项媒体";
          workSelectionEnabled = msg.selected > 0;
          btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
          if (!workSelectionEnabled && !isCollecting && !isDownloading) {
            btnCollect.textContent = "本笔记已取消选择";
            btnCollect.disabled = true;
            btnCollect.className = "btn btn-gray";
          } else if (workSelectionEnabled && !isCollecting && !isDownloading) {
            showReady("加入待下载");
          }
        }
      } else if (currentSite === "behance") {
        if (currentPageType === "project") {
          pageTypeEl.textContent = "Behance 项目：已选 " + msg.selected + " / " + msg.total + " 张正文图片";
          workSelectionEnabled = msg.selected > 0;
          btnToggleWorkSelection.textContent = workSelectionEnabled ? "取消选择此作品的全部图片" : "重新选择此作品的全部图片";
          if (!workSelectionEnabled && !isCollecting && !isDownloading) showUnsupported("本作品已取消选择");
          else if (workSelectionEnabled && !isCollecting && !isDownloading) showReady("加入待下载");
        }
      } else if (currentPageType === "pin") {
        pageTypeEl.textContent = "Pin 详情页：已选 " + msg.selected + " / " + msg.total + " 个推荐 Pin";
      } else {
        var prefix = currentPageType === "board" ? "画板" : "搜索页";
        pageTypeEl.textContent = prefix + "：已选 " + msg.selected + " / " + msg.total + " 个 Pin";
      }
    }

    if (msg.action === "PAGE_TYPE") {
      currentPageType = msg.pageType;
      if (msg.site) currentSite = msg.site;
      errorMsg.style.display = "none";
      if (!isCollecting && !isDownloading) showReadyForPageType(currentPageType);
      setTimeout(function() { bindActiveTab(false); }, 250);
    }

    if (msg.action === "FILTER_START") {
      filterSummary.textContent = "正在检查 " + msg.total + " 张候选图...";
    }
    if (msg.action === "FILTER_PROGRESS") {
      filterSummary.textContent = "正在过滤 " + msg.current + " / " + msg.total;
    }
    if (msg.action === "FILTER_DONE") renderFilterStats(msg.stats);

    if (msg.action === "BOARD_INFO") {
      currentPageType = "board";
      errorMsg.style.display = "none";
      pageTypeEl.textContent = "画板：" + msg.title + " (" + msg.pinCount + " 个 Pin)";
    }

    if (msg.action === "PIN_INFO") {
      currentPageType = "pin";
      errorMsg.style.display = "none";
      pageTypeEl.textContent = "Pin 详情页：" + (msg.text || "无描述");
    }

    if (msg.action === "COLLECT_PROGRESS") {
      var pct = Math.round((msg.current / msg.total) * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = "加载 Pin " + msg.current + " / " + msg.total;
    }

    if (msg.action === "COLLECT_START") {
      progressText.textContent = "开始采集 " + msg.total + " 个 Pin...";
    }

    if (msg.action === "COLLECT_DONE") {
      progressFill.style.width = "100%";
      progressText.textContent = "采集完成！新增 " + (msg.added || 0) + " 张" +
        (msg.skipped > 0 ? "，跳过 " + msg.skipped + " 张重复" : "");
      showReadyForPageType(currentPageType);
      refreshStats();
    }

    if (msg.action === "WORK_SELECTION_EMPTY") {
      errorMsg.style.display = "none";
      progressSection.style.display = "block";
      progressFill.style.width = "0%";
      progressText.textContent = msg.message || "本作品当前没有选中内容";
      btnCollect.textContent = "本作品已取消选择";
      btnCollect.disabled = true;
      btnCollect.className = "btn btn-gray";
    }

    if (msg.action === "PENDING_QUEUE_CHANGED") {
      refreshStats();
    }

    if (msg.action === "DL_PROGRESS") {
      var dlPct = Math.round((msg.current / msg.total) * 100);
      progressFill.style.width = dlPct + "%";
      var batchInfo = "";
      if (msg.totalBatches > 1) {
        batchInfo = " [第" + msg.batch + "/" + msg.totalBatches + "批]";
      }
      progressText.textContent = "下载图片 " + msg.current + " / " + msg.total +
        " (成功 " + msg.ok + " / 失败 " + msg.fail + ")" + batchInfo;
    }

    if (msg.action === "DL_ZIPPING") {
      var zipPct = msg.percent || 0;
      progressFill.style.width = zipPct + "%";
      var batchInfo = "";
      if (msg.totalBatches > 1) {
        batchInfo = " (第" + msg.batch + "/" + msg.totalBatches + "批)";
      }
      progressText.textContent = "正在整理文件" + batchInfo + "... " + zipPct + "%";
      btnStop.style.display = "none";
    }


    if (msg.action === "DL_DONE") {
      progressFill.style.width = "100%";
      var doneText = "下载完成！" + msg.ok + " 个文件";
      if (msg.visualDuplicates > 0) {
        doneText += "，视觉重复跳过 " + msg.visualDuplicates + " 张";
      }
      if (msg.fail > 0) {
        var reasons = Object.keys(msg.failureReasons || {}).map(function(reason) { return reason + " " + msg.failureReasons[reason] + " 张"; });
        doneText += "；失败 " + msg.fail + " 张已保留，可重新下载";
        if (reasons.length) doneText += "（" + reasons.join("、") + "）";
      }
      progressText.textContent = doneText;
      resetUI();
      refreshStats();
      setTimeout(refreshStats, 500);
    }

    if (msg.action === "DL_ERROR") {
      showError(msg.message);
      resetUI();
    }

    if (msg.action === "ABORTED") {
      if (msg.phase === "download" && msg.completedBatches !== undefined) {
        var done = msg.completedBatches;
        var total = msg.totalBatches;
        var info = "下载已暂停";
        if (total > 1) {
          info += "（已完成 " + done + "/" + total + " 批）";
        } else {
          info += "（已下载 " + (msg.ok || 0) + "/" + msg.total + " 张）";
        }
        progressText.textContent = info;
        progressFill.style.width = Math.round((msg.processed / msg.total) * 100) + "%";

        pendingResumeFrom = done;
        isDownloading = false;
        isCollecting = false;
        btnStop.style.display = "none";
        forceReset.style.display = "none";

        btnDownload.style.display = "block";
        btnDownload.textContent = "\u25B6 继续下载";
        btnDownload.disabled = false;
        btnDownload.className = "btn btn-green";

        btnCollect.style.display = "block";
        showReadyForPageType(currentPageType);
        refreshStats();
      } else if (msg.phase === "collect") {
        progressText.textContent = "采集已停止（已处理 " + msg.processed + "/" + msg.total + "）";
        progressFill.style.width = "0%";
        pendingResumeFrom = -1;
        resetUI();
        refreshStats();
      } else {
        progressText.textContent = "任务已停止";
        progressFill.style.width = "0%";
        pendingResumeFrom = -1;
        resetUI();
        refreshStats();
      }
    }

    if (msg.action === "ERROR") {
      showError(msg.message);
      isCollecting = false;
      btnStop.style.display = "none";
      forceReset.style.display = "none";
      showReadyForPageType(currentPageType);
      refreshStats();
    }
  });

})();
