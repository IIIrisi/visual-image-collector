(function(root) {
  "use strict";

  function ascii(bytes, start, length) {
    var value = "";
    for (var i = start; i < start + length && i < bytes.length; i++) value += String.fromCharCode(bytes[i]);
    return value;
  }

  async function sniffBlobKind(blob) {
    var bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
    if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image";
    if (ascii(bytes, 0, 3) === "GIF") return "image";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image";
    if (ascii(bytes, 4, 4) === "ftyp") {
      var brand = ascii(bytes, 8, 4).toLowerCase();
      if (/avif|avis|heic|heix|mif1|msf1/.test(brand)) return "image";
      return "video";
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video";
    var type = String(blob.type || "").toLowerCase();
    if (/^video\//.test(type)) return "video";
    if (/^image\//.test(type)) return "image";
    return "unknown";
  }

  function videoExtension(blob, url) {
    var type = String(blob && blob.type || "").toLowerCase();
    var source = String(url || "").toLowerCase();
    if (/webm/.test(type) || /\.webm(?:[?#]|$)/.test(source)) return ".webm";
    if (/quicktime|\bmov\b/.test(type) || /\.mov(?:[?#]|$)/.test(source)) return ".mov";
    return ".mp4";
  }

  root.AestheticMediaUtils = { sniffBlobKind: sniffBlobKind, videoExtension: videoExtension };
})(typeof globalThis !== "undefined" ? globalThis : this);
