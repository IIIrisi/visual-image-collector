// url-watcher.js - 在 MAIN world 中拦截 pushState/replaceState
// 通过 postMessage 通知 content script (ISOLATED world) URL 已变化
// 必须在 manifest 中声明 "world": "MAIN", "run_at": "document_start"
(function() {
  var origPush = history.pushState;
  var origReplace = history.replaceState;

  history.pushState = function() {
    var result = origPush.apply(this, arguments);
    window.postMessage({
      type: "__HUABAN_URL_CHANGE__",
      url: location.href
    }, "*");
    return result;
  };

  history.replaceState = function() {
    var result = origReplace.apply(this, arguments);
    window.postMessage({
      type: "__HUABAN_URL_CHANGE__",
      url: location.href
    }, "*");
    return result;
  };
})();
