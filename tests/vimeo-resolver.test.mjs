import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, "background.js"), "utf8");
const match = source.match(/  function extractAssignedJson[\s\S]*?\n  async function resolveVimeoPlayer/);
assert.ok(match, "Vimeo player-config helpers must remain extractable");
const helpers = match[0].replace(/\n  async function resolveVimeoPlayer$/, "");
const context = { result: null, JSON, String, Number, Array };
vm.createContext(context);
vm.runInContext(helpers, context);

test("Vimeo player config parsing keeps nested JSON and chooses the largest exposed MP4", () => {
  context.html = '<script>window.playerConfig = {"request":{"files":{"progressive":[' +
    '{"mime":"video/mp4","width":640,"height":360,"url":"https://vod.example/360.mp4"},' +
    '{"mime":"video/mp4","width":1920,"height":1080,"url":"https://vod.example/1080.mp4"}' +
    ']}},"video":{"title":"A {nested} title"}};</script>';
  vm.runInContext('result = vimeoProgressiveFiles(extractAssignedJson(html, "window.playerConfig ="));', context);
  assert.equal(context.result.length, 2);
  assert.equal(context.result[0].url, "https://vod.example/1080.mp4");
});

test("Vimeo HLS-only config is not mislabeled as a downloadable MP4", () => {
  context.html = '<script>window.playerConfig={"request":{"files":{"progressive":[],"hls":{"cdns":{"akfire_interconnect_quic":{"url":"https://vod.example/master.m3u8"}}}}}};</script>';
  vm.runInContext('var parsed = extractAssignedJson(html, "window.playerConfig="); result = { progressive: vimeoProgressiveFiles(parsed), hls: vimeoHlsUrls(parsed) };', context);
  assert.equal(context.result.progressive.length, 0);
  assert.equal(context.result.hls[0], "https://vod.example/master.m3u8");
});
