import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "lib/media-utils.js"), "utf8");
const context = { Blob, Uint8Array };
vm.runInNewContext(source, context, { filename: "media-utils.js" });
const utils = context.AestheticMediaUtils;

test("recognizes real MP4 bytes even with a generic response type", async () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  assert.equal(await utils.sniffBlobKind(new Blob([bytes], { type: "application/octet-stream" })), "video");
});

test("rejects a JPEG cover even when the queue declares it as video", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  assert.equal(await utils.sniffBlobKind(new Blob([bytes], { type: "video/mp4" })), "image");
});

test("does not mistake an AVIF ftyp image for MP4", async () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0]);
  assert.equal(await utils.sniffBlobKind(new Blob([bytes], { type: "image/avif" })), "image");
});
