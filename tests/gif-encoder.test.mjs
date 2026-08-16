import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "lib/gif-encoder.js"), "utf8");

test("encodes multiple RGBA frames as an animated GIF89a blob", async () => {
  const context = { Blob, Uint8Array, Map, Math };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "gif-encoder.js" });
  const red = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  const green = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  const blob = context.AestheticGifEncoder.encode(2, 2, [
    { rgba: red, delayCs: 10 }, { rgba: green, delayCs: 10 }
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 6)), "GIF89a");
  assert.equal(bytes[bytes.length - 1], 0x3b);
  assert.equal(bytes.filter((value, index) => value === 0x21 && bytes[index + 1] === 0xf9).length, 2);
});
