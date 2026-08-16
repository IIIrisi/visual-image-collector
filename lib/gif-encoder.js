(function(global) {
  "use strict";

  function bytesToSubBlocks(bytes) {
    var output = [];
    for (var offset = 0; offset < bytes.length; offset += 255) {
      var size = Math.min(255, bytes.length - offset);
      output.push(size);
      for (var i = 0; i < size; i++) output.push(bytes[offset + i]);
    }
    output.push(0);
    return output;
  }

  function lzwEncode(indices) {
    var output = [], accumulator = 0, bitCount = 0;
    var dictionary = new Map(), clearCode = 256, endCode = 257, nextCode = 258, codeSize = 9;
    function write(code) {
      accumulator |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        output.push(accumulator & 255);
        accumulator >>>= 8;
        bitCount -= 8;
      }
    }
    function reset() { dictionary.clear(); nextCode = 258; codeSize = 9; }
    write(clearCode);
    if (!indices.length) { write(endCode); return output; }
    var prefix = indices[0];
    for (var i = 1; i < indices.length; i++) {
      var suffix = indices[i], key = prefix * 256 + suffix;
      if (dictionary.has(key)) {
        prefix = dictionary.get(key);
        continue;
      }
      write(prefix);
      if (nextCode < 4096) {
        dictionary.set(key, nextCode++);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        write(clearCode);
        reset();
      }
      prefix = suffix;
    }
    write(prefix);
    write(endCode);
    if (bitCount > 0) output.push(accumulator & 255);
    return output;
  }

  function palette332() {
    var palette = [];
    for (var i = 0; i < 256; i++) {
      palette.push(Math.round(((i >> 5) & 7) * 255 / 7));
      palette.push(Math.round(((i >> 2) & 7) * 255 / 7));
      palette.push((i & 3) * 85);
    }
    return palette;
  }

  function rgbaTo332(rgba) {
    var pixels = new Uint8Array(rgba.length / 4);
    for (var i = 0, p = 0; i < rgba.length; i += 4, p++) {
      pixels[p] = (rgba[i] & 224) | ((rgba[i + 1] & 224) >> 3) | (rgba[i + 2] >> 6);
    }
    return pixels;
  }

  function word(output, value) { output.push(value & 255, (value >> 8) & 255); }

  function encode(width, height, frames) {
    width = Math.max(1, Math.min(65535, Math.round(width)));
    height = Math.max(1, Math.min(65535, Math.round(height)));
    if (!frames || !frames.length) throw new Error("GIF 至少需要一帧");
    var output = [71, 73, 70, 56, 57, 97]; // GIF89a
    word(output, width); word(output, height);
    output.push(247, 0, 0); // 256 色全局色表
    output.push.apply(output, palette332());
    // 无限循环
    output.push(33, 255, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0);
    frames.forEach(function(frame) {
      var delay = Math.max(2, Math.min(65535, Math.round(frame.delayCs || 10)));
      output.push(33, 249, 4, 4, delay & 255, (delay >> 8) & 255, 0, 0);
      output.push(44); word(output, 0); word(output, 0); word(output, width); word(output, height); output.push(0, 8);
      var blocks = bytesToSubBlocks(lzwEncode(rgbaTo332(frame.rgba)));
      for (var b = 0; b < blocks.length; b++) output.push(blocks[b]);
    });
    output.push(59);
    return new Blob([new Uint8Array(output)], { type: "image/gif" });
  }

  global.AestheticGifEncoder = { encode: encode };
})(typeof globalThis !== "undefined" ? globalThis : this);
