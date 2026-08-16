(function(root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.HuabanFilter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";

  var DEFAULTS = {
    enabled: true,
    alphaRatio: 0.15,
    isolatedSubjectRatio: 0.70,
    adSuspiciousScore: 3,
    adRejectScore: 6,
    detectTransparency: true
  };

  var AD_WORDS = [
    "限时", "优惠", "折扣", "满减", "领券", "包邮", "抢购", "下单", "购买",
    "立即购买", "立即抢购", "新品上市", "售价", "价格", "活动时间", "联系电话",
    "招商", "加盟", "扫码", "店铺", "促销", "预售", "福利", "特价", "秒杀"
  ];

  function mergeSettings(value) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function(key) { out[key] = DEFAULTS[key]; });
    if (value && typeof value === "object") {
      Object.keys(DEFAULTS).forEach(function(key) {
        if (value[key] !== undefined) out[key] = value[key];
      });
    }
    return out;
  }

  function result(state, reason, confidence, metrics) {
    return {
      state: state,
      reason: reason || null,
      confidence: confidence || 0,
      metrics: metrics || {}
    };
  }

  function isCopyrightMaterial(pin) {
    if (!pin) return false;
    if (pin.isCopyright || pin.is_copyright || pin.copyright_material || pin.is_copyright_material) return true;
    var values = [pin.text, pin.raw_text, pin.title, pin.description, pin.label, pin.badge];
    if (Array.isArray(pin.tags)) {
      pin.tags.forEach(function(tag) { values.push(typeof tag === "string" ? tag : tag && (tag.name || tag.title)); });
    }
    return values.some(function(value) {
      return /(版权\s*(?:素材|图片|作品|文件)|(?:素材|图片|作品)\s*版权|PSD\s*(?:素材|源文件|下载)|(?:素材|源文件)\s*PSD|正版素材|付费素材|可商用素材)/i.test(String(value || ""));
    });
  }

  function hashDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    var distance = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
    return distance;
  }

  function isVisualDuplicate(hash, existingHashes, threshold) {
    threshold = threshold === undefined ? 2 : threshold;
    return (existingHashes || []).some(function(existing) {
      return hashDistance(hash, existing) <= threshold;
    });
  }

  function adScore(text, width, height) {
    var source = String(text || "").toLowerCase();
    var hits = [];
    AD_WORDS.forEach(function(word) {
      if (source.indexOf(word) !== -1) hits.push(word);
    });
    var score = Math.min(4, hits.length * 2);
    if (/(¥|￥|¥)\s*\d|\d+(\.\d+)?\s*元/.test(source)) score += 2;
    if (/\b(qr|wechat|wx|tel|phone)\b/.test(source)) score += 1;
    var ratio = width > 0 && height > 0 ? Math.max(width / height, height / width) : 1;
    return { score: score, hits: hits, ratio: ratio };
  }

  function classifyMetadata(pin, settings) {
    settings = mergeSettings(settings);
    var width = Number(pin && pin.width) || 0;
    var height = Number(pin && pin.height) || 0;
    var metrics = { width: width, height: height };

    if (!settings.enabled) return result("accepted", null, 1, metrics);
    if (isCopyrightMaterial(pin)) {
      return result("rejected", "copyright_material", 1, metrics);
    }

    var ad = adScore(pin && pin.text, width, height);
    metrics.adScore = ad.score;
    metrics.adHits = ad.hits;
    if (ad.score >= settings.adSuspiciousScore) {
      return result("rejected", "ad_content", ad.score >= settings.adRejectScore ? 0.92 : 0.78, metrics);
    }
    return result("accepted", null, 1, metrics);
  }

  function classifyPixels(pixelInfo, settings) {
    settings = mergeSettings(settings);
    if (!settings.enabled || !settings.detectTransparency || !pixelInfo) {
      return result("accepted", null, 1, pixelInfo || {});
    }
    if (pixelInfo.decodeFailed) return result("accepted", "decode_failed", 0.55, pixelInfo);
    if (pixelInfo.alphaRatio >= settings.alphaRatio &&
        pixelInfo.subjectRatio <= settings.isolatedSubjectRatio) {
      return result("rejected", "transparent_asset", 0.96, pixelInfo);
    }
    if (pixelInfo.alphaRatio >= settings.alphaRatio) {
      return result("suspicious", "has_transparency", 0.70, pixelInfo);
    }
    return result("accepted", null, 1, pixelInfo);
  }

  function combine(metadata, pixels, duplicate) {
    var candidates = [metadata, pixels, duplicate].filter(Boolean);
    var rejected = candidates.find(function(item) { return item.state === "rejected"; });
    if (rejected) return rejected;
    var suspicious = candidates.find(function(item) { return item.state === "suspicious"; });
    return suspicious || result("accepted", null, 1);
  }

  function reasonLabel(reason) {
    return ({
      transparent_asset: "透明单体",
      has_transparency: "含透明区域",
      ad_content: "广告内容",
      copyright_material: "版权素材",
      decode_failed: "读取失败（默认通过）",
      manual_excluded: "手动排除"
    })[reason] || "已过滤";
  }

  return {
    DEFAULTS: DEFAULTS,
    mergeSettings: mergeSettings,
    isCopyrightMaterial: isCopyrightMaterial,
    hashDistance: hashDistance,
    isVisualDuplicate: isVisualDuplicate,
    adScore: adScore,
    classifyMetadata: classifyMetadata,
    classifyPixels: classifyPixels,
    combine: combine,
    reasonLabel: reasonLabel,
    result: result
  };
});
