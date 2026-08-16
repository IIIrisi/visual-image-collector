import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, "behance-content.js"), "utf8");
const match = source.match(/  function projectState\(doc\) \{[\s\S]*?\n  function moduleIdForImage/);
assert.ok(match, "Behance GIF metadata helpers must remain extractable");
const helpers = match[0].replace(/\n  function moduleIdForImage$/, "");

test("Behance keeps the original GIF asset independently from embedded video modules", () => {
  const state = { project: { project: { allModules: [
    { __typename: "EmbedModule", id: 1, originalEmbed: '<iframe src="https://player.vimeo.com/video/1"></iframe>' },
    { __typename: "ImageModule", id: 2, width: 600, height: 400,
      src: "https://mir-s3-cdn-cf.behance.net/project_modules/disp_still/demo.gif",
      imageSizes: { allAvailable: [
        { type: "JPG", url: "https://mir-s3-cdn-cf.behance.net/project_modules/disp_still/demo.jpg", width: 600 },
        { type: "GIF", url: "https://mir-s3-cdn-cf.behance.net/project_modules/source/demo.gif", width: 1800 }
      ] } }
  ] } } };
  const context = {
    result: null,
    canonicalUrl(value) { return value; },
    projectId() { return "247397693"; },
    projectTitle() { return "Animated Behance Project"; },
    JSON
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  context.doc = { querySelector(selector) {
    return selector === "#beconfig-store_state" ? { textContent: JSON.stringify(state) } : null;
  } };
  vm.runInContext("result = gifRecords(doc);", context);
  assert.equal(context.result.length, 1);
  assert.equal(context.result[0].url, "https://mir-s3-cdn-cf.behance.net/project_modules/source/demo.gif");
  assert.equal(context.result[0].fileType, "image/gif");
  assert.equal(context.result[0].id, "behance:247397693:gif:2");
});

test("Behance binds GIF metadata to the matching project module instead of its static preview", () => {
  assert.match(source, /gifByModule\.get\(moduleId\) \|\| recordFromImage\(img, index\)/);
  assert.match(source, /record = Object\.assign\(\{\}, record, \{ element: img/);
  assert.match(source, /mediaType: record\.mediaType \|\| "image", isVimeo: record\.isVimeo === true/);
});

test("Behance recognizes every Vimeo EmbedModule and keeps its player URL for download-time resolving", () => {
  const state = { project: { project: { allModules: [
    { __typename: "EmbedModule", id: 31, width: 1920, height: 1080,
      originalEmbed: '<iframe src="https://player.vimeo.com/video/1126818583?autoplay=1&amp;loop=1"></iframe>' },
    { __typename: "EmbedModule", id: 32,
      fluidEmbed: '<iframe src="https://player.vimeo.com/video/99887766?muted=1"></iframe>' }
  ] } } };
  const context = {
    result: null,
    canonicalUrl(value) { return value; }, projectId() { return "236322533"; },
    projectTitle() { return "Vimeo Behance Project"; },
    document: { createElement() { return { value: "", set innerHTML(value) {
      this.value = String(value).replace(/&amp;/g, "&");
    } }; } },
    JSON, String, Number, Array
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  context.doc = { querySelector(selector) {
    return selector === "#beconfig-store_state" ? { textContent: JSON.stringify(state) } : null;
  } };
  vm.runInContext("result = vimeoRecords(doc);", context);
  assert.equal(context.result.length, 2);
  assert.equal(context.result[0].id, "behance:236322533:vimeo:31");
  assert.equal(context.result[0].mediaType, "video");
  assert.equal(context.result[0].isVimeo, true);
  assert.equal(context.result[0].url, "https://player.vimeo.com/video/1126818583?autoplay=1&loop=1");
});
