# 同频

支持私聊、群聊、文字、图片、音频、视频、文件。图片直接查看，音视频播放，其余文件下载。每文件上限严格小于 100,000,000 字节。音视频无法在 Chromium 播放的编码可下载后打开。

## 本机使用

项目根 PowerShell：

```powershell
.\environment\scripts\setup.ps1
.\environment\scripts\start.ps1
```

浏览器访问 `http://127.0.0.1:18200`，或打开 `outputs/TeamRelay-win32-x64/TeamRelay.exe`。Windows 客户端为便携文件夹，须完整保留文件夹内容；不需要安装 Python。其他电脑填写真实服务器 HTTPS 地址。

2026-11-07 原开发机曾显式生成隔离演示数据，随机账号放在 `environment/config/demo-accounts.json`。该文件不进仓库，干净 clone 不含演示账号或运行数据库。首次使用请按下方创建管理员；切勿用演示数据直接上线。

首次正式管理员设置（运行在 workspace 目录；密码从当前进程环境获取，不放命令参数）：

```powershell
$secure = Read-Host '管理员密码（10–200 字符）' -AsSecureString
$env:IM_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
..\environment\venv\Scripts\python.exe -m server.cli init-admin --data-dir ..\environment\data --username admin
Remove-Item Env:\IM_ADMIN_PASSWORD
```

已有同名账号不会覆盖。管理员登录后可在设置中创建成员和工作助手。

## 验证与构建

```powershell
.\environment\scripts\verify.ps1
# 需要本机隔离演示服务、系统 Chrome：
.\environment\venv\Scripts\python.exe .\environment\scripts\verify-ui.py
# 官方 DSH Desktop SDK 握手，不请求模型：
.\workspace\bridge\run-desktop.ps1 -Handshake
cd workspace
npm run build
```

`verify.ps1` 检查服务器、备份与桥接可靠性、客户端语法。UI 验证创建隔离测试群并保留演示数据用于查看。`environment/config/requirements.lock.txt` 锁定本机 Python 完整依赖，workspace/package-lock.json 锁定桌面构建。Node22 可开发客户端；桥接普通 Node 运行需 Node>=24.9，官方 Desktop 路线使用发行包自带 Node。

## 服务器与备份

腾讯 Linux 部署见 [deploy/README.md](deploy/README.md)。采用单 FastAPI 进程 + SQLite WAL + 文件持久卷。请勿自行增加 Uvicorn worker。

在 workspace 运行：

```powershell
..\environment\venv\Scripts\python.exe -m tools.backup backup --data-dir ..\environment\data --archive ..\environment\verification\backup.tar.gz
..\environment\venv\Scripts\python.exe -m tools.backup restore --data-dir ..\environment\verification\restored --archive ..\environment\verification\backup.tar.gz
```

备份含私有聊天与账号会话，妥善保存。恢复只允许新空目录，校验数据库与附件哈希；不要覆盖运行中的数据目录。

## 版本发布

根目录脚本 `environment/scripts/publish-iteration.ps1 -Version <新标签> -Message <说明> -Files <本轮文件列表>` 可先验证再 commit/tag/push；执行前审查其暂存范围及工作树。脚本拒绝混入已有暂存内容，只推送本次指定标签，不改全局凭证配置；本机 Git 凭证管理需事先可用。必须选择未使用的新 tag，已有 v0.1.1 不可重用。GitHub 默认仓库 `walcracia/agent_bot_im`，代码中没有令牌。通用接续要求见根 AGENTS 和 `proj_multihandoff`。

限制：首版没有实时音视频通话、转码、集群或端到端加密。DSH 官方 SDK 初始化/恢复与既有本地 Qwen 文本推理已验证；真实IM→Harness→本地模型→回复传输通过，但模型多输出前缀，严格答复格式断言失败，未重试。工具/媒体理解/复杂任务及用户自己的DeepSeek付费模型未验证，见 bridge/LOCAL-MODEL-TEST.md。未取得腾讯地址/SSH/域名信息，尚未远程部署。
