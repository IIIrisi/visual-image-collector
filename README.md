<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="Aesthetic Image Collector icon">
</p>

# Aesthetic Image Collector

<p align="center">
  <strong>审美图采集助手 · v1.8.10</strong><br>
  A local-first Chrome extension for collecting images, GIFs, and videos from visual-reference platforms.
</p>

<p align="center">
  <a href="README.zh-CN.md">中文说明</a> · <strong>English</strong>
</p>

The extension supports Huaban, Pinterest, ZCOOL, Xiaohongshu, and Behance. Selected media from different pages and platforms can be accumulated in one persistent queue, deduplicated, and exported in batches without sending your queue or account credentials to a remote service.

> This repository contains extension source code only. It includes no account credentials, browser profiles, collected media, or private-board data.

## What's new in v1.8.10

- Restored the Xiaohongshu selection runtime to the proven v1.8.8 behavior. The v1.8.9 top-bar visual cropping change has been removed, so Live, image, and regular-video selection boxes no longer inherit that experimental adjustment.
- Behance Vimeo downloads still prefer the highest progressive MP4 exposed by the player.
- When Vimeo exposes HLS only, the extension now parses the master playlist, chooses the highest-quality variant, and merges its initialization segment and ordered fMP4 fragments into an MP4 download.
- Behance GIF handling, the pending queue, ZIP export, deduplication, and the other site adapters remain compatible with v1.8.9.

See [CHANGELOG.md](CHANGELOG.md) for the complete version history.

## Supported platforms

| Platform | Supported pages | Collected media |
| --- | --- | --- |
| Huaban | Boards, search results, pin details, and recommendation feeds | Images |
| Pinterest | Home, search, boards, and pin-related feeds | Images |
| ZCOOL | Work detail pages | Project images, GIFs, and supported videos |
| Xiaohongshu | Note detail pages and carousels | Images, regular videos, and per-slide Live/Motion Photo MP4 streams |
| Behance | Project detail pages | Project images, original GIFs, and Vimeo video streams |

Site layouts and media APIs change over time. If a page is not recognized, open the actual board, pin, note, work, or project detail page and try again.

## Core features

- Chrome Manifest V3 side panel that opens from the extension icon.
- Per-item selection overlays on supported pages.
- Cross-page and cross-platform pending queue stored in `chrome.storage.local`.
- Deduplication against both the active queue and compact local download history.
- Mixed image, GIF, and video export with original animation/video formats preserved where supported.
- Six-request bounded concurrency, live progress, stop/resume controls, and recoverable failed items.
- Huaban smart filtering for supported exclusion signals, with manual selection remaining available.
- Local ZIP or batch saving through Chrome's download API.
- No analytics backend, cloud queue, or built-in account credentials.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions/` in desktop Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the directory containing `manifest.json`.
5. Pin the extension if desired, then click its icon to open the side panel.
6. Sign in to a supported site with your own account when the content requires authentication.

After replacing the source with a newer version, return to `chrome://extensions/` and click **Reload** on the extension card.

## Basic workflow

1. Open a supported content page.
2. Select or deselect the media items shown by the page overlay.
3. Click **Add to pending** or the page-specific collection action.
4. Continue browsing and add more items from other pages or platforms.
5. Review the pending and deduplication counts in the side panel.
6. Start the download/export task. You can stop and resume without discarding the completed portion.

Use **Clear pending** to remove the active queue while retaining download-history deduplication. Use **Full reset** only when you also want to clear that local history.

## Platform notes

### Xiaohongshu Live/Motion Photos

- Each supported carousel slide is bound to its own real video stream.
- Static WebP covers are excluded when a Live stream is identified.
- Blob-backed playback can recover recently loaded MP4 resources from the page runtime.
- v1.8.10 intentionally uses the v1.8.8 selection-box behavior to avoid the visual regression introduced in v1.8.9.

### Behance Vimeo

- Resolution happens at download time because Vimeo player URLs can expire or expose different formats per session.
- Progressive MP4 is preferred when available.
- HLS-only players use the highest-bandwidth variant and fMP4 segment merging.
- A failed or unavailable stream remains recoverable in the pending/failed workflow with an explanatory error.

## Privacy and permissions

The extension runs locally in Chrome and has no project-operated backend.

| Permission | Purpose |
| --- | --- |
| `activeTab` | Communicate with the supported page currently being used. |
| `storage` | Store queue state, settings, task progress, and deduplication history locally. |
| `downloads` | Save generated ZIP or media output through Chrome. |
| `sidePanel` | Display the persistent collection interface. |
| Site host access | Detect media and request runtime resources on the five supported platforms and their media CDNs. |

The extension does not request Chrome's `cookies` permission. Authenticated requests use the current browser session at runtime; Cookie values are not exported or stored in this repository. See [docs/PRIVACY.md](docs/PRIVACY.md) for the data-flow notes.

## Development and verification

Requirements: Node.js 18 or later. The verification suite has no npm package dependencies.

```bash
npm run verify
```

Equivalent direct commands:

```bash
node scripts/verify.mjs
node --test tests/*.test.mjs
```

The suite validates the Manifest, host permissions, required files, JavaScript syntax, sensitive-field patterns, local queue behavior, animated GIF handling, Xiaohongshu extraction/selection behavior, and Vimeo progressive/HLS resolution.

## Architecture

```text
Supported page adapters
  -> selection overlays and normalized media records
  -> background.js persistent queue and local deduplication
  -> popup.js side-panel controls and mixed-media downloader
  -> Chrome Downloads / ZIP output
```

The project is intentionally dependency-light and uses bundled browser-side utilities such as JSZip and the local media helpers in `lib/`.

## Known limitations

- Selectors and embedded metadata depend on the current structure of third-party sites.
- Signed image and video URLs may expire; complete queued downloads promptly.
- Vimeo availability depends on what the player exposes to the current browser session.
- HLS fMP4 merging requires compatible, unencrypted segments and enough browser memory.
- Large mixed-media ZIP tasks are limited by available browser memory and disk space.
- Automated tests use fixtures and mocks; they do not replace live-page verification after a platform redesign.

## Responsible use

Only collect content you are authorized to access and use. Private content follows the permissions of the currently signed-in account. Users remain responsible for platform terms, copyright, privacy, and other content rights.

## License

[MIT](LICENSE)
