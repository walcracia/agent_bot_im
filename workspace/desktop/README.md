# Windows 客户端

UI 是 `../client/` 的原生 HTML/CSS/JS；Electron 主进程只管理窗口和文件保存，没有向渲染器开放 Node 或 IPC 执行能力。登录令牌只在内存中，localStorage 只保存服务器根地址和用户名。

## 开发和打包

在 workspace 执行：

```powershell
npm ci --no-audit --no-fund
npm run check
npm start
npm run build
```

锁定 Electron 45.2.3、@electron/packager 20.3.0。构建输出到项目 `outputs/TeamRelay-win32-x64/TeamRelay.exe`。构建先在 `environment/build/desktop-stage-*` 复制显式白名单，仅包含 client、desktop/main.cjs 和精简 package.json，服务器、DSH SDK、凭据与运行数据不会进入客户端。

网络不能直接下载 GitHub release 时，可以在本机进程环境设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；下载使用 electron npm 包内的官方 checksums 校验，不能关闭 TLS 或跳过校验。共享缓存可设置 `electron_config_cache=D:\Work\codexproj\_shared\caches\electron`。npm 包下载中断后若缺少 native unzip 绑定，应按锁文件重新安装该依赖，不能用错误架构的绑定替代。

## 主要行为

- 单窗口、本地 UI，nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true；拒绝任意新窗口、外部导航和 WebView，保留默认 HTTPS 证书校验。
- HTTP 使用 Bearer；WebSocket 使用一次性短期票据，指数退避重连并重读历史。消息以 id 去重，失败重试沿用 client_id。
- 文件逐个上传，展示进度，失败可重试。文件 >=100000000 字节前端拒绝，后端再次检查。消息发布失败时重用已上传 attachment，避免重复上传。
- 图片/音频/视频使用短时媒体票据，加载失败可重新获取票据或下载。图片和视频占位尺寸固定，异步解码不会把末条消息推到编辑器下面；用户已手动滚动时不抢回底部。
- Enter 发送、Shift+Enter 换行；中文输入法组合期间不发送。文字仅用 textContent，用户内容不解析成 HTML。
- 详情栏在窄屏默认收起，可通过按钮打开覆盖面板；最小桌面窗口 960×680。

## 验证入口

`npm run check` 检查三个 JS 入口语法。完整浏览器及正式 EXE 端到端验证由项目环境脚本执行。稳定 DOM：login-form、server-url、username、password、login-submit、conversation-list、new-chat、message-input、send-message、message-items、file-input、nav-members、nav-settings、nav-logout。会话有 `data-conversation-id`，消息有 `data-message-id`，成员选择有 `data-user-id`。

本地测试 profile 可通过 `TEAMRELAY_PROFILE` 环境变量隔离。桌面不提供默认团队密码，演示账号需要由服务器显式 seed。
