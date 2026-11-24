# 同频TeamPlay

当前源码与Windows客户端 v0.5.4。产品设计、团队/IM/DSH/代码项目业务流程、Super-agent核对及能力边界统一见[根README](../README.md)。QA新增Bug及群贴编号经Trigger/Router调用本机DSH skill并回传报告；当前按[QA-MONITORING-v0.4.2](docs/QA-MONITORING-v0.4.2.md)只统计用量，不以额度/阅读/调用次数暂停。实际绑定和运行见最新HANDOFF/state，未配置机器不因clone自动启用。

支持私聊、群聊、文字、图片、音频、视频、文件。图片直接查看，音视频播放，其余文件下载。每文件上限严格小于 100,000,000 字节。音视频无法在 Chromium 播放的编码可下载后打开。

## 本机使用

项目根 PowerShell：

```powershell
.\environment\scripts\setup.ps1
# 已经绑定DSH时，服务与监听同步启动；重复运行复用已核验的进程
.\environment\scripts\start.ps1
```

浏览器访问 `http://127.0.0.1:18200`，或打开本次构建的 `outputs/desktop-v0.5.4/TeamRelay-win32-x64/TeamRelay.exe`（Release解压后为 `TeamRelay-win32-x64/TeamRelay.exe`）。Windows 客户端为便携文件夹，须完整保留文件夹内容；不需要安装 Python。其他电脑填写真实服务器 HTTPS 地址。最小化留在任务栏；关闭窗口隐藏到托盘继续接收消息，右键托盘选择“退出”才退出客户端；不停止独立服务器或DSH。

2026-11-07 原开发机曾显式生成隔离演示数据，随机账号放在 `environment/config/demo-accounts.json`。该文件不进仓库，干净 clone 不含演示账号或运行数据库。首次使用请按下方创建管理员；切勿用演示数据直接上线。

首次正式管理员设置（运行在 workspace 目录；密码从当前进程环境获取，不放命令参数）：

```powershell
$secure = Read-Host '管理员密码（10–200 字符）' -AsSecureString
$env:IM_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
..\environment\venv\Scripts\python.exe -m server.cli init-admin --data-dir ..\environment\data --username admin
Remove-Item Env:\IM_ADMIN_PASSWORD
```

已有同名账号不会覆盖。管理员登录后可在设置中创建成员和工作助手。

首次空检出尚无DSH绑定，先用 `environment/scripts/start.ps1 -ServerOnly` 启动服务，创建成员/助手并将助手加入指定群。在项目根准备独立代码副本：

```powershell
git worktree add -b codex/dsh-agent-bot-im environment/tools/dsh/worktrees/agent-bot-im HEAD
.\workspace\bridge\connect-installed.ps1 -Workspace .\environment\tools\dsh\worktrees\agent-bot-im -EnableStartup -PassThru | Out-Null
.\environment\scripts\start.ps1
```

绑定入口会在本机输入助手连接码、选择群与派任务成员；Windows当前用户加密保存连接码，后续start无需再输入。已有副本有修改时保留，勿重复创建或清空。默认start只有IM和监听均就绪才成功；stop先等当前DSH事件结束再关服务，超时保留运行。完整规则见 `docs/STARTUP-v0.2.1.md`。

## 验证与构建

```powershell
.\environment\scripts\verify.ps1
# 自动使用临时服务/数据，需要系统 Chrome：
.\environment\venv\Scripts\python.exe .\environment\scripts\verify-ui-v0.1.2.py
# 官方 DSH Desktop SDK 握手，不请求模型：
.\workspace\bridge\run-desktop.ps1 -Handshake
cd workspace
npm run build
```

`verify.ps1` 检查服务器、备份与桥接可靠性、客户端语法。上述UI验证自动清理临时服务和数据，截图保留在忽略目录；旧 `verify-ui.py` 依赖历史演示服务，不用于新机器恢复。`environment/config/requirements.lock.txt` 锁定本机 Python 完整依赖，workspace/package-lock.json 锁定桌面构建。客户端工具需Node>=22.12；桥接需Node>=24.9，官方Desktop路线使用发行包自带Node。本机若默认Node较旧，按 `environment/README.md` 将项目隔离Node目录前置当前进程PATH。

上方首次绑定建立旧兼容auto入口。启用每任务并行、独立监督和GitHub交付的新模式，继续按[Super-agent操作](docs/SUPER-OPERATIONS-v0.3.0.md)配置/转换；保存旧账本，不能直接清空或覆盖未完成任务。

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

限制：没有实时音视频通话、转码、集群或端到端加密。早期Qwen答复格式失败保留在 bridge/LOCAL-MODEL-TEST.md；后续v0.3.0已增加真实小夹具编码、并行、原生steer与工具daemon验收，见[历史报告](../outputs/VERIFICATION-v0.3.0.md)。任意复杂任务、全部媒体理解、真正异机长期运行及腾讯部署仍未因此获得验证；本轮没有真实模型调用或正式监听启动。
# v0.5.0 通用业务运行

本机已将DSH/Hermes/Pi接到可信Worker登记与只读AI路由，在授权聊天提出具体需求即可按能力派发，结果一条消息+完整TXT返回。配置方式见bridge/README与根RESTORE；操作仍使用统一start/stop入口。2026-11-23用户恢复QA测试，DSH/Pi/Hermes统一Qwen4 Max、High，沿原检查点读取已绑定项目；每轮都重新打包，实际验收见MODEL-QWEN-v0.5.3、VERIFICATION-v0.5.3及最新HANDOFF。实际回归、未实现范围和交付SHA以根README/HANDOFF及outputs最新报告为准。

本轮及后续软件迭代必须真实QA验收后再交付：verify-qa-live.mjs显式send/check生成本版收据，deliver-windows.ps1必需-QaReceipt。具体参数/授权及完整验收见根README、QA-MVP-v0.5.4和VERIFICATION-v0.5.4；离线verify.ps1不触发真实模型。
