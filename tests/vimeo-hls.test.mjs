import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, "popup.js"), "utf8");
const match = source.match(/  function hlsAttributes[\s\S]*?\n  async function fetchHlsText/);
assert.ok(match, "Vimeo HLS parsing helpers must remain extractable");
const helpers = match[0].replace(/\n  async function fetchHlsText$/, "");
const context = { result: null, URL, String, Number, Array, Error };
vm.createContext(context);
vm.runInContext(helpers, context);

test("Vimeo HLS master chooses the highest-bandwidth video variant", () => {
  context.master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
360/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080
1080/video.m3u8`;
  vm.runInContext('result = hlsVariants(master, "https://vod.example/master.m3u8");', context);
  assert.equal(context.result[0].url, "https://vod.example/1080/video.m3u8");
});

test("Vimeo HLS media parser keeps the init segment and ordered fMP4 fragments", () => {
  context.media = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
segment-1.m4s
#EXTINF:4.0,
segment-2.m4s
#EXT-X-ENDLIST`;
  vm.runInContext('result = hlsMediaParts(media, "https://vod.example/1080/video.m3u8");', context);
  assert.deepEqual(Array.from(context.result, item => item.url), [
    "https://vod.example/1080/init.mp4",
    "https://vod.example/1080/segment-1.m4s",
    "https://vod.example/1080/segment-2.m4s"
  ]);
});
