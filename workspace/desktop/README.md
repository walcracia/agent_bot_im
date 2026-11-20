# 同频TeamPlay Windows 客户端

UI 是 `../client/` 的原生 HTML/CSS/JS；Electron 主进程管理窗口、托盘和文件保存。隔离preload仅传未读数量/前台状态，不开放Node、任意IPC或执行能力。登录令牌只在内存中，localStorage只保存服务器根地址和用户名。

## 托盘与提醒

最小化保留任务栏；关闭窗口隐藏到托盘继续接收消息。单击/双击图标或右键“打开同频TeamPlay”恢复；右键“退出”真正退出客户端，独立服务器/DSH不因此停止。同一用户目录重复启动会恢复已有窗口，测试可用独立TEAMRELAY_PROFILE。

后台新消息使托盘未读标记以900ms交替，并请求Windows任务栏闪烁；前台停止闪烁，其他聊天未读不清空。隐藏/最小化/失焦不自动标读；初始历史、自发和重复消息不重复提醒。位置与系统动画最终由Windows控制，无聊天正文系统弹窗。

## 开发和打包

在 workspace 执行：

```powershell
npm ci --no-audit --no-fund
npm run check
npm start
npm run build
```

锁定Electron45.2.3、@electron/packager20.3.0。输出沿用TeamRelay兼容路径；versioned构建在outputs/desktop-v<版本>/。打包显式白名单：client五文件、desktop的main/shell/preload三个入口、四个图标和精简package.json，服务器、DSH、测试/图标生成器、凭据与运行数据不进包。开发图标由generate-icons.py从现有logo.svg生成，源SVG改变后需重生成并验证。

网络不能直接下载 GitHub release 时，可以在本机进程环境设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；下载使用 electron npm 包内的官方 checksums 校验，不能关闭 TLS 或跳过校验。共享缓存可设置 `electron_config_cache=D:\Work\codexproj\_shared\caches\electron`。npm 包下载中断后若缺少 native unzip 绑定，应按锁文件重新安装该依赖，不能用错误架构的绑定替代。

## 主要行为

- 单窗口、本地 UI，nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true；拒绝任意新窗口、外部导航和 WebView，保留默认 HTTPS 证书校验。
- HTTP 使用 Bearer；WebSocket 使用一次性短期票据，指数退避重连并重读历史。消息以 id 去重，失败重试沿用 client_id。
- 文件逐个上传，展示进度，失败可重试。文件 >=100000000 字节前端拒绝，后端再次检查。消息发布失败时重用已上传 attachment，避免重复上传。
- 图片/音频/视频使用短时媒体票据，加载失败可重新获取票据或下载。图片和视频占位尺寸固定，异步解码不会把末条消息推到编辑器下面；用户已手动滚动时不抢回底部。
- Enter 发送、Shift+Enter 换行；中文输入法组合期间不发送。文字仅用 textContent，用户内容不解析成 HTML。
- 详情栏在窄屏默认收起，可通过按钮打开覆盖面板；最小桌面窗口 960×680。

## 验证入口

`npm run check`检查五个JS入口，`npm run test:desktop`覆盖生命周期/IPC单测。`environment/scripts/verify-desktop-tray-ui.py`使用真实临时IM和Chrome、模拟桌面桥验证未读；`verify-desktop-native.py`使用真实打包Electron/Tray/IPC、合成账号和隔离profile验证原生窗口与提醒（程序驱动事件，非人工托盘点击）。两者不接正式数据或模型。稳定DOM和消息/会话data属性保持既有约定。

本地测试 profile 可通过 `TEAMRELAY_PROFILE` 环境变量隔离。桌面不提供默认团队密码，演示账号需要由服务器显式 seed。
