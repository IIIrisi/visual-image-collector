import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".tmp"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const popup = await readFile(join(root, "popup.html"), "utf8");
const popupScript = await readFile(join(root, "popup.js"), "utf8");
const mediaUtils = await readFile(join(root, "lib/media-utils.js"), "utf8");
const huabanScript = await readFile(join(root, "content.js"), "utf8");
const pinterestScript = await readFile(join(root, "pinterest-content.js"), "utf8");
const zcoolScript = await readFile(join(root, "zcool-content.js"), "utf8");
const xhsScript = await readFile(join(root, "xhs-content.js"), "utf8");
const xhsInject = await readFile(join(root, "xhs-inject.js"), "utf8");
const behanceScript = await readFile(join(root, "behance-content.js"), "utf8");
const overlayStyle = await readFile(join(root, "styles/overlay.css"), "utf8");
check(manifest.manifest_version === 3, "manifest_version must be 3");
check(manifest.version === pkg.version, "manifest and package versions must match");
check(basename(root) === `${manifest.name}-${manifest.version}`, "release folder name must match extension name and version");
check(!popup.includes('class="version"'), "top version badge must be removed");
check(popup.includes(`<span>V${manifest.version}</span>`), "popup footer version must match manifest version");
check(popupScript.includes('imageSourceLabel(image) + "-" + originalImageName(image)'), "side-panel source-aware image naming rule is missing");
check(huabanScript.includes('getDateStr(downloadStartTime) + "-花瓣-"'), "Huaban image naming rule is missing");
check(pinterestScript.includes('dateString() + "-Pinterest-"'), "Pinterest image naming rule is missing");
check(popupScript.includes('/^zcool:/i.test'), "ZCOOL work-title naming rule is missing");
check(popupScript.includes('/^xiaohongshu:/i.test') && popupScript.includes('return "小红书"'), "Xiaohongshu export naming rule is missing");
check(huabanScript.includes("manualAcceptedPins.has(pid)"), "Huaban manual filter override is missing");
check(zcoolScript.includes('host.appendChild(overlay)'), "ZCOOL media-bound overlay is missing");
check(!zcoolScript.includes('addEventListener("scroll", schedulePositionSync'), "ZCOOL overlay must not chase scroll coordinates");
check(overlayStyle.includes(".zcool-dl-overlay-host") && overlayStyle.includes("position: absolute;"), "ZCOOL overlay host positioning is missing");
check(!overlayStyle.includes("top: 8px;\n  right: 8px;\n  bottom: auto;"), "ZCOOL badge must share Huaban bottom-right positioning");
check(!zcoolScript.includes("rect.width >= 500"), "ZCOOL header ads must not pass a large-image fallback");
check(zcoolScript.includes('overlay.className = "huaban-dl-overlay zcool-dl-image-layer"'), "ZCOOL must reuse the Huaban overlay structure");
check(zcoolScript.includes('host.querySelector(":scope > .huaban-dl-badge[data-zcool-id]")'), "ZCOOL must reuse the Huaban badge structure");
check(zcoolScript.includes("ensureCompleteCatalog()"), "ZCOOL full-work lazy-image recovery is missing");
check(zcoolScript.includes('var completeCatalog = new Map()'), "ZCOOL complete body-image catalog is missing");
check(!zcoolScript.includes("contentAncestor && width >= 300"), "ZCOOL broad content-size fallback must stay disabled");
check(zcoolScript.includes('attributeFilter: ["src", "srcset", "data-src"'), "ZCOOL lazy-source observer is missing");
check(zcoolScript.includes('document.addEventListener("load"'), "ZCOOL media-load trigger is missing");
check(popup.includes('id="pluginEnabled"'), "popup plugin master switch is missing");
check(popup.includes('id="btnToggleWorkSelection"'), "ZCOOL whole-work selection toggle is missing");
check(popup.includes('href="https://my.feishu.cn/share/base/form/shrcn8255GH50XpGieGHbjmDiab?from=navigation"'), "feedback footer URL is missing");
check(popup.includes("问题反馈</a>"), "feedback footer label is missing");
check(popupScript.includes('showReady("加入待下载")') && popupScript.includes('? "采集本页图片" : "加入待下载"'), "add-to-pending button label is missing");
check(popupScript.includes("filter-dot-normal") && popupScript.includes("filter-dot-suspicious") && popupScript.includes("filter-dot-rejected") && popupScript.includes("filter-dot-manual"), "filter status color legend is missing");
check(popupScript.includes("手动排除 ") && popupScript.includes("stats.manualExcluded"), "manual-exclusion counter is missing");
check(huabanScript.includes("stats.manualExcluded++") && huabanScript.includes("stats.accepted++"), "Huaban live filter-state totals are missing");
check(pinterestScript.includes("manualExcluded: manualCount"), "Pinterest live manual-exclusion total is missing");
check(zcoolScript.includes("manualExcluded: manualCount"), "ZCOOL live manual-exclusion total is missing");
check(zcoolScript.includes('msg.action === "SET_WORK_SELECTION"'), "ZCOOL whole-work selection handler is missing");
check(zcoolScript.includes('action: "WORK_SELECTION_EMPTY"'), "ZCOOL empty-selection state is missing");
check(xhsInject.includes("noteDetailMap") && xhsInject.includes("imageList"), "Xiaohongshu complete note-media extraction is missing");
check(xhsScript.includes('site: "xiaohongshu"') && xhsScript.includes('pageType() !== "note"'), "Xiaohongshu detail-only collection guard is missing");
check(xhsScript.includes('msg.action === "SET_WORK_SELECTION"') || xhsScript.includes('message.action === "SET_WORK_SELECTION"'), "Xiaohongshu whole-note selection handler is missing");
check(xhsScript.includes("removePending(record)") && xhsScript.includes("restorePending(record)"), "Xiaohongshu pending-queue selection sync is missing");
check(xhsScript.includes("renderedMediaRect(element, record)") && xhsScript.includes("objectPositionOffset"), "Xiaohongshu rendered-content boundary calculation is missing");
check(xhsScript.includes("bestVisibleElement()") && xhsScript.includes("currentSlideIndex(requireActuallyVisible)"), "Xiaohongshu active-slide selection is missing");
check(xhsScript.includes('outlineElement.classList.toggle("xhs-dl-direct-selected"') && xhsScript.includes("outlineElementForMedia") && !xhsScript.includes('document.body.appendChild(overlay)'), "Xiaohongshu player-container outline is missing");
check(overlayStyle.includes(".xhs-dl-direct-selected") && overlayStyle.includes("outline-color: #22c55e"), "Xiaohongshu direct media outline style is missing");
check(xhsScript.includes('id = "xhs-dl-active-outline"') && xhsScript.includes("stableSelectionRect(activeXhsElement, activeXhsRecord)") && overlayStyle.includes(".xhs-dl-image-layer.is-selected"), "Xiaohongshu rendered-image boundary overlay is missing");
check(xhsScript.includes("activeXhsMotionStable") && xhsScript.includes('classList.add("xhs-dl-motion-hidden")') && overlayStyle.includes(".xhs-dl-motion-hidden") && !overlayStyle.includes("outline-color: transparent !important;\n  box-shadow: none"), "Xiaohongshu motion-time badge suppression with persistent outline is missing");
check(!xhsScript.includes("elementFromPoint") && xhsScript.includes("carouselStillVisible"), "Xiaohongshu overlay-safe badge visibility rule is missing");
check(xhsInject.includes("originalImageUrl") && xhsInject.includes("imageInfo(image)"), "Xiaohongshu original-image URL extraction is missing");
check(xhsInject.includes("watermark|watermarktype") && xhsScript.includes("watermark|watermarktype"), "Xiaohongshu display-watermark URL cleanup is missing");
check(popupScript.includes("animatedImageToGif") && popupScript.includes("fetchQueueMedia") && popupScript.includes("fetchedMedia.isVideo"), "animated-image/video export support is missing");
check(xhsInject.includes("livePhotoInfo") && xhsScript.includes("isLiveVideo") && popupScript.includes('kind !== "video"') && popupScript.includes('compression: "STORE"'), "Xiaohongshu Live-video ZIP export is missing");
check(xhsInject.includes("backupUrls") && xhsScript.includes("backupUrls") && popupScript.includes("queueMediaUrls") && (await readFile(join(root, "background.js"), "utf8")).includes("backupUrls"), "Xiaohongshu backup video stream chain is missing");
check(xhsInject.includes("refreshFallbackVideoUrls") && xhsInject.includes('meta[property="og:video"]') && xhsInject.includes('masterUrl|master_url') && xhsInject.includes('document.querySelectorAll("video, video source")'), "Xiaohongshu fresh-page video fallback chain is missing");
check(xhsScript.includes("liveHostForElement(element)") && xhsScript.includes("if (livePhotoElement) return null"), "Xiaohongshu Live static-cover exclusion is missing");
check(xhsScript.includes("preserveLiveVisual") && xhsScript.includes("activeXhsRecord.id === record.id") && xhsScript.includes("record.isLiveVideo === true || element.tagName"), "Xiaohongshu Live img/video node-switch stability is missing");
check(xhsScript.includes("record.isLiveVideo ? (record.width") && xhsScript.includes("liveCover && liveCover.width"), "Xiaohongshu Live cover-ratio geometry lock is missing");
check(xhsScript.includes("从不使用外层容器尺寸") && xhsScript.includes("activeXhsLiveFrame") &&
  !xhsScript.includes("activeXhsLiveContainer") && !xhsScript.includes("liveContainerForElement"), "Xiaohongshu Live actual-rendered-area outline lock is missing");
check(xhsScript.includes("liveRecordByHost") && xhsScript.includes("liveHostForElement") &&
  xhsScript.includes("宿主只用于继承媒体记录"), "Xiaohongshu Live media-node replacement inheritance is missing");
check(xhsScript.includes("currentSlideIndex(requireActuallyVisible)") && xhsScript.includes("位于当前视口") &&
  xhsScript.includes("currentSlideIndex(liveMediaElement)"), "Xiaohongshu Live visible carousel-page rebinding is missing");
check(xhsScript.includes("actualImageReady") && xhsScript.includes("element.naturalWidth > 0") && xhsScript.includes("element.naturalHeight > 0"), "Xiaohongshu actual-image-only outline guard is missing");
check(xhsScript.includes("leaveNoteImmediately()") && xhsScript.includes('if (pageType() !== "note")') && xhsScript.includes("下一动画帧立即删除 fixed 选框"), "Xiaohongshu immediate note-close cleanup is missing");
check(!xhsScript.includes("fixedTopOcclusion()") && !xhsScript.includes("fixedOutline.style.clipPath"), "Xiaohongshu selection outline must stay on the 1.8.8 implementation");
check(popupScript.includes('"下载 " + stats.imageCount + " 项到本地"'), "local-download button label is missing");
check(overlayStyle.includes(".xhs-dl-direct-selected") && overlayStyle.includes("box-shadow: none !important") && !overlayStyle.includes("rgba(34, 197, 94, 0.08)"), "selected green overlay fill was not removed");
check(xhsInject.includes('_114\\.mp4') && xhsInject.includes('_115\\.mp4'), "Xiaohongshu stable MP4 variant priority is missing");
check(popup.includes('lib/media-utils.js') && mediaUtils.includes("sniffBlobKind") && popupScript.includes('kind !== "video"'), "real video-byte validation is missing");
check(xhsInject.includes("isVideo: hasPrimaryVideo") && xhsScript.includes("if (note.isVideo)") && xhsScript.includes("primaryVideo"), "Xiaohongshu video-poster selection binding is missing");
check(xhsInject.includes("fallbackLastAttempt") && xhsInject.includes("fallbackVideoUrls.length") && xhsInject.includes("Date.now() - fallbackLastAttempt < 1200"), "Xiaohongshu empty Live fallback retry is missing");
check(xhsInject.includes("liveUrlsBySlide") && xhsInject.includes("captureVisibleLiveVideo(id)") && xhsInject.includes("liveUrlsBySlide[index + 1]"), "Xiaohongshu per-slide first-open Live stream binding is missing");
check(xhsInject.includes("liveSlidesByIndex") && xhsInject.includes('performance.getEntriesByType("resource")') && xhsInject.includes("liveSlidesByIndex[index + 1]"), "Xiaohongshu Live cover exclusion or blob-backed MP4 recovery is missing");
check(xhsInject.includes("liveResourceGroups") && xhsInject.includes("assignCompleteLiveResourceBatch") &&
  xhsInject.includes("不能再把多个轮播页的流都合并"), "Xiaohongshu per-slide Live MP4 stream grouping is missing");
check(behanceScript.includes('site: "behance"') && behanceScript.includes("/project_modules/") && behanceScript.includes('"/project_modules/source/"'), "Behance project-module extraction is missing");
check(behanceScript.includes('pageType() !== "project"') && behanceScript.includes("请进入 Behance 项目详情页后采集"), "Behance detail-only collection guard is missing");
check(behanceScript.includes('msg.action === "SET_WORK_SELECTION"') && behanceScript.includes('pin_id: record.id'), "Behance selection or queue integration is missing");
check(behanceScript.includes('module.__typename !== "EmbedModule"') && behanceScript.includes("vimeoRecords(doc)") &&
  behanceScript.includes("isVimeo: true"), "Behance Vimeo recognition is missing");
check(popupScript.includes("resolveVimeoMedia") && popupScript.includes('action: "RESOLVE_VIMEO"') &&
  (await readFile(join(root, "background.js"), "utf8")).includes("vimeoProgressiveFiles"), "Vimeo MP4 download-time resolver is missing");
check(popupScript.includes("fetchVimeoHls") && popupScript.includes("hlsMediaParts") &&
  (await readFile(join(root, "background.js"), "utf8")).includes("vimeoHlsUrls"), "Vimeo HLS fallback is missing");
check(popupScript.includes('/^behance:/i.test') && popupScript.includes('return "Behance"'), "Behance export naming rule is missing");
check(popupScript.includes("resizeWidth: 16") && popupScript.includes('compression: "STORE"') && popupScript.includes("AbortController"), "Behance large-image nonblocking export guard is missing");
check(popupScript.includes('showReady("加入待下载")') && popup.includes("取消选择此作品的全部图片"), "work/note pending-queue button labels are missing");
check(popup.includes('lib/jszip.min.js') && popupScript.includes("new JSZip") && popupScript.includes("generateAsync"), "combined ZIP export is missing");
check(popupScript.includes('filename: filename, saveAs: true') && !popupScript.includes("showDirectoryPicker"), "single standard ZIP save dialog rule is missing");
check(pinterestScript.includes('var folderName = "审美图-" + dateString()') && !pinterestScript.includes("new JSZip"), "Pinterest folder-download rule is missing");
check(huabanScript.includes('var folderName = "审美图-" + getDateStr(downloadStartTime)') && !huabanScript.includes("new JSZip"), "Huaban folder-download rule is missing");
check(popupScript.includes('action: "REMOVE_BOARD_IMAGES"'), "ZCOOL pending-work withdrawal request is missing");
check((await readFile(join(root, "background.js"), "utf8")).includes('msg.action === "REMOVE_BOARD_IMAGES"'), "pending-work withdrawal handler is missing");
check(huabanScript.includes("manualDeselectedPins.has"), "Huaban manual gray-state override is missing");
check(huabanScript.includes("lastSelectionMessage"), "Huaban stable selection-count updates are missing");
check(pinterestScript.includes("lastSelectionMessage"), "Pinterest stable selection-count updates are missing");
check(huabanScript.includes('action: "PENDING_QUEUE_CHANGED"') && huabanScript.includes("removePendingPins([pid])"), "Huaban pending-queue deselection sync is missing");
check(pinterestScript.includes('action: "PENDING_QUEUE_CHANGED"') && pinterestScript.includes("if (!choose) removePendingPins"), "Pinterest pending-queue deselection sync is missing");
check((huabanScript.match(/removePendingPins\(Array\.from\(manualDeselectedPins\)\)/g) || []).length >= 3, "Huaban post-collection deselection race guard is missing");
check(pinterestScript.includes("removePendingPins(Array.from(manualDeselectedPins))"), "Pinterest post-collection deselection race guard is missing");
check(popupScript.includes('msg.action === "PENDING_QUEUE_CHANGED"'), "pending-queue live refresh is missing");
check(huabanScript.includes("removedPendingPins") && huabanScript.includes("restorePendingPins([pid])"), "Huaban pending-queue restore is missing");
check(pinterestScript.includes("removedPendingPins") && pinterestScript.includes("else restorePendingPins([record.id])"), "Pinterest pending-queue restore is missing");
check(popup.includes('class="footer-left"') && popup.includes("五月和小麦🌾</span><i"), "feedback footer placement is missing");
check(zcoolScript.includes("lastSelectionMessage"), "ZCOOL stable selection-count updates are missing");
check(overlayStyle.includes("#f59e0b"), "Huaban suspicious yellow state is missing");
for (const [site, source] of [["Huaban", huabanScript], ["Pinterest", pinterestScript], ["ZCOOL", zcoolScript], ["Xiaohongshu", xhsScript], ["Behance", behanceScript]]) {
  check(source.includes('msg.action === "UPDATE_PLUGIN_ENABLED"'), `${site} plugin master-switch handler is missing`);
  check(source.includes('message: "插件已关闭"'), `${site} disabled collection guard is missing`);
}
check(!(manifest.permissions || []).includes("cookies"), "the extension must not request cookies permission");
check(!(manifest.host_permissions || []).includes("<all_urls>"), "host scope must not use <all_urls>");

const expectedHosts = new Set(pkg.releaseConfig.allowedHosts);
const actualHosts = new Set(manifest.host_permissions || []);
check(actualHosts.size === expectedHosts.size, "host permission count changed");
for (const host of actualHosts) check(expectedHosts.has(host), `unexpected host permission: ${host}`);

const requiredFiles = [
  "background.js", "content.js", "pinterest-content.js", "zcool-content.js", "xhs-content.js", "xhs-inject.js", "filter-engine.js", "inject.js", "url-watcher.js",
  "popup.html", "popup.js", "lib/gif-encoder.js", "lib/media-utils.js",
  "styles/overlay.css", "styles/popup.css",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png"
];
for (const file of requiredFiles) {
  try { check((await stat(join(root, file))).isFile(), `missing required file: ${file}`); }
  catch { failures.push(`missing required file: ${file}`); }
}

for (const file of ["background.js", "content.js", "pinterest-content.js", "zcool-content.js", "xhs-content.js", "xhs-inject.js", "filter-engine.js", "inject.js", "url-watcher.js", "popup.js", "lib/gif-encoder.js"]) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  check(result.status === 0, `${file} has invalid JavaScript syntax: ${result.stderr.trim()}`);
}

const secretPattern = /(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization\s*:|bearer\s+|password\s*=|cookie\s*=)/i;
for (const file of await walk(root)) {
  if (!/\.(js|json|html|css)$/i.test(file)) continue;
  const source = await readFile(file, "utf8");
  check(!secretPattern.test(source), `possible credential in ${relative(root, file)}`);
}

if (failures.length) {
  console.error("Verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OK: ${manifest.name} ${manifest.version}`);
console.log(`Checked ${requiredFiles.length} required files, syntax, permissions, host scope, and credentials.`);
