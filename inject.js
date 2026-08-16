// inject.js - 在 MAIN world 中读取 __NEXT_DATA__
// 通过 window.postMessage 传回 content script (ISOLATED world)
(function() {
  try {
    var nd = window.__NEXT_DATA__;
    if (!nd || !nd.props || !nd.props.pageProps) {
      window.postMessage({ type: "__HUABAN_EXT_DATA__", payload: { error: "no __NEXT_DATA__" } }, "*");
      return;
    }
    var pageProps = nd.props.pageProps;

    // 画板页：serversideBoard + serverSidePins
    if (pageProps.serversideBoard) {
      var board = pageProps.serversideBoard;
      var pins = pageProps.serverSidePins || [];
      var pinData = pins.map(function(pin) {
        return {
          pin_id: pin.pin_id,
          url: pin.file ? pin.file.url : "",
          fileKey: pin.file ? pin.file.key : "",
          fileType: pin.file ? pin.file.type : "",
          width: pin.file ? pin.file.width : 0,
          height: pin.file ? pin.file.height : 0,
          text: pin.raw_text || "",
          title: pin.title || "",
          description: pin.description || "",
          tags: pin.tags || [],
          isCopyright: !!(pin.is_copyright || pin.copyright_material || pin.is_copyright_material)
        };
      }).filter(function(p) { return p.url; });

      window.postMessage({
        type: "__HUABAN_EXT_DATA__",
        payload: {
          pageType: "board",
          board: {
            board_id: board.board_id,
            title: board.title || "未命名画板",
            pin_count: board.pin_count || 0,
            user_id: board.user_id,
            description: board.description || ""
          },
          pins: pinData
        }
      }, "*");
      return;
    }

    // Pin 详情页：pin 对象 + 推荐 pin（inlinks / relatedBoards）
    if (pageProps.pin) {
      var pin = pageProps.pin;

      // 提取推荐 pin 数据
      var recPins = [];
      var seenPids = {};
      seenPids[pin.pin_id] = true; // 排除主 pin

      // 从 inlinks 提取（相关 pin）
      if (pageProps.inlinks && Array.isArray(pageProps.inlinks)) {
        pageProps.inlinks.forEach(function(p) {
          if (p.pin_id && !seenPids[p.pin_id] && p.file && p.file.url) {
            seenPids[p.pin_id] = true;
            recPins.push({
              pin_id: p.pin_id,
              url: p.file.url,
              fileKey: p.file.key || "",
              fileType: p.file.type || "",
              width: p.file.width || 0,
              height: p.file.height || 0,
              text: p.raw_text || "",
              title: p.title || "",
              description: p.description || "",
              tags: p.tags || [],
              isCopyright: !!(p.is_copyright || p.copyright_material || p.is_copyright_material)
            });
          }
        });
      }

      // 从 relatedBoards 提取（推荐画板内的 pin）
      if (pageProps.relatedBoards && Array.isArray(pageProps.relatedBoards)) {
        pageProps.relatedBoards.forEach(function(board) {
          var bPins = board.pins || board.serverSidePins || [];
          if (Array.isArray(bPins)) {
            bPins.forEach(function(p) {
              if (p.pin_id && !seenPids[p.pin_id] && p.file && p.file.url) {
                seenPids[p.pin_id] = true;
                recPins.push({
                  pin_id: p.pin_id,
                  url: p.file.url,
                  fileKey: p.file.key || "",
                  fileType: p.file.type || "",
                  width: p.file.width || 0,
                  height: p.file.height || 0,
                  text: p.raw_text || "",
                  title: p.title || "",
                  description: p.description || "",
                  tags: p.tags || [],
                  isCopyright: !!(p.is_copyright || p.copyright_material || p.is_copyright_material)
                });
              }
            });
          }
        });
      }

      window.postMessage({
        type: "__HUABAN_EXT_DATA__",
        payload: {
          pageType: "pin",
          pin: {
            pin_id: pin.pin_id,
            url: pin.file ? pin.file.url : "",
            fileKey: pin.file ? pin.file.key : "",
            fileType: pin.file ? pin.file.type : "",
            width: pin.file ? pin.file.width : 0,
            height: pin.file ? pin.file.height : 0,
            text: pin.raw_text || pin.text || "",
            title: pin.title || "",
            description: pin.description || "",
            tags: pin.tags || [],
            isCopyright: !!(pin.is_copyright || pin.copyright_material || pin.is_copyright_material),
            boardId: pin.board ? pin.board.board_id : 0,
            boardTitle: pin.board ? (pin.board.title || "") : "",
            creator: pin.user ? (pin.user.username || "") : ""
          },
          recommendedPins: recPins
        }
      }, "*");
      return;
    }

    // 搜索页或其他
    window.postMessage({
      type: "__HUABAN_EXT_DATA__",
      payload: { pageType: "other", error: "no board or pin data" }
    }, "*");

  } catch(e) {
    window.postMessage({ type: "__HUABAN_EXT_DATA__", payload: { error: e.message } }, "*");
  }
})();
