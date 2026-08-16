# Privacy and Data Flow / 隐私与数据流

## English

Huaban Downloader runs locally in Chrome. It has no remote backend and does not transmit analytics or account credentials to the project author.

- `activeTab` connects the popup to the current supported page.
- `storage` keeps the queue, task state, and deduplication history locally.
- `downloads` saves generated ZIP files through Chrome.
- Huaban host permissions allow the content script to read supported pages and fetch runtime image resources.
- `credentials: "include"` asks Chrome to use the current installer's same-origin Huaban session. The extension does not read, export, or hardcode Cookie values.

Clearing pending tasks removes the active queue but keeps deduplication history. A full reset removes both.

## 中文

Huaban Downloader 只在本地 Chrome 中运行，没有远程后端，也不会向项目作者发送统计信息或账号凭据。

1.1.0 的透明度、视觉重复和广告线索检测同样全部在浏览器本地执行；过滤结果与设置只保存在扩展本地状态，不会发送到外部服务。

- `activeTab` 用于连接当前支持页面。
- `storage` 在本地保存队列、任务状态和去重历史。
- `downloads` 通过 Chrome 保存生成的 ZIP。
- 花瓣域名权限用于读取支持页面和请求运行时图片资源。
- `credentials: "include"` 由 Chrome 使用当前安装者自己的同源花瓣会话；插件不会读取、导出或硬编码 Cookie 值。

“清空待下载”会删除当前队列但保留去重历史；“完全重置”会同时删除两者。
