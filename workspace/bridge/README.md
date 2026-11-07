# DSH 异机桥接

先读根 `AGENTS.md`、`RESTORE.md`、`environment/state.json`、`workspace/docs/HANDOFF.md`。详细设计见本目录 `DESIGN.md`，一手来源和文章摘要见 `references/DSH-SOURCES.md`。

## Windows 官方 Desktop 路线

在项目根 PowerShell 执行：

```powershell
& .\workspace\bridge\setup-desktop.ps1 -CheckoutSource
& .\workspace\bridge\run-desktop.ps1 -Handshake
```

脚本校验官方安装包签名与固定 SHA-256，然后只解压本项目的 `environment/tools/dsh/desktop`；不运行安装器，不改注册表/PATH，不碰已有 `~/.dsh`。需要 7-Zip，可用 `-SevenZip` 指定 exe 路径。官方 latest URL 将来更新导致摘要不符时脚本拒绝继续；人工核验新版本、SDK兼容性后再修改 pin。源码检出仅作核验；本次使用官方编译并签名的发行包，没有本机重编译整个上游 Desktop。

官方 SDK 原始 tarball 解压到 `environment/tools/dsh/sdk-client`。`desktop-resolver.mjs` 使用 Node 标准 module hooks，把该 SDK 的包导入解析到官方 Desktop 的同版本 `app.asar/dsh` 依赖。上游 JS 无改写；运行时用 Desktop 自带的 Electron Node24，避免系统 Node22版本不满足要求。

`-Handshake` 启动真正的官方 SDK runtime、initialize、读取工作目录、shutdown。它不发 prompt，不请求模型、不需要机器人 token；成功输出实际 serverInfo。协议服务 version `0.0.1` 与发行包版本 `0.2.2-rc.1` 属不同版本域。真实模型工作必须另外配置自己的模型凭据，不可把握手通过解释为模型执行通过。

## 配置并运行

`setup-desktop.ps1` 首次从示例复制 `config.local.json`（Git忽略）。需要填写：

- `baseUrl`：腾讯 IM 的 HTTPS origin；本机可用 `http://127.0.0.1:18200`。
- `botUsername`：管理员创建的机器人账号名，默认为 `dsh`。
- `conversationIds`：明确允许监听/工作的会话 ID；机器人也必须已加入这些会话。
- `senderIds`：允许发起工作的用户 ID。两个列表默认都空，空列表不执行。
- `harness.cwd`：DSH执行任务目录；`dshHome`：独立的Harness持久状态。路径相对于配置文件。
- `provider`、`model`、可选 `patches`/`dshBin`：按已有官方 SDK 配置；默认官方 DeepSeek route。不连接 Desktop 的私有 HTTP 端口。

机器人 token 只放进环境变量，例子不包含凭据。可通过客户端管理员界面创建机器人和 token，再用授权 API 获取用户/会话 ID。

```powershell
$env:TEAM_RELAY_BOT_TOKEN = '<本机安全输入的机器人 token>'
# 只有实际要让模型工作时才配置自己的 provider 凭据；例如 DEEPSEEK_API_KEY。
& .\workspace\bridge\run-desktop.ps1
```

该命令启动隐藏的独立进程并等待退出；stdout/stderr 在忽略目录 `environment/logs/bridge-runtime*.log`。停止时终止拥有桥接的进程或前台 Ctrl+C。SDK 在正常退出时关闭子进程；强制杀进程后须检查任务是否已执行。IM token 从 Harness 子进程环境移除，模型不需接触它。

私聊直接触发；群聊只有精确 `@dsh` 触发（中文紧连如 `@dsh请` 不视为独立 mention，请加空格）。来源为其他机器人或自己的消息不会触发。按会话隔离 SDK session，重启用 `resumeSession` 恢复。附件下载校验同源/尺寸/SHA-256，不用用户文件名拼本地路径：在解析后的 executor cwd 直接新建不可预测 `.team-relay-incoming-*` 私有目录，再用 wx 独占创建文件，不复用预建 incoming 目录或 .part 链接；真实路径仍须位于 cwd 内。图像可作为 SDK image block，其他媒体提供本地文件路径。不会自动执行附件。IM 正文不会拼到 shell 命令里。这些检查防止预置链接覆盖工作区外文件，但不是对同 OS 用户后台恶意进程的真正 sandbox；需要进程隔离时请用专用系统用户或容器。

额外审批请求默认拒绝并回传说明；结构化追问转为 IM 消息后取消该等待，用户可发新消息继续。此版本逐任务执行，后续消息保留在 IM 事件流排队；它尚未实现文章的并行 Router/Worker 调度。

## 重试与异常恢复

正常重启读取 `statePath`，不清游标。IM HTTP 失败自动退避。结果在回复前持久化，回复失败只重发结果；同一 event/part 的 `client_id` 恒定，网络丢响应不产生重复结果。

桥接发现任何已存在的 `<statePath>.lock` 都会拒绝启动，即使记录的 PID 看似已退出也不会自动删除。这样避免两个重启实例同时接管状态、重复执行任务。异常退出遗留锁时，先读取锁中的 PID，检查该桥接以及其 Harness 子进程，确认所有相关进程已退出且没有其他实例正在启动，再删除**锁文件本身**。例如使用默认配置时：

```powershell
Get-Content -LiteralPath .\environment\data\bridge\state.json.lock
# 根据上一步 PID 检查进程和子进程；确认均已退出后才执行下一行。
Remove-Item -LiteralPath .\environment\data\bridge\state.json.lock
```

保留 `state.json`，不要为解除锁清空游标/结果。若进程仍存在、PID被其他进程复用、锁无法读取或仍在运行新实例，先查清所有者再处理。解除锁后仍按下面的 started/uncertain 规则决定任务是否重试，不会自动复跑。

如果进程在模型/工具执行期间中断，状态会是 `started`/`uncertain`。桥接停止，不自动重复可能产生副作用的任务。先查看 DSH 该会话与执行目录，确定处理方式，再明确执行其一：

```powershell
& .\workspace\bridge\run-desktop.ps1 -RetryEvent 123 -Once
& .\workspace\bridge\run-desktop.ps1 -SkipEvent 123 -Once
```

`-RetryEvent` 重新执行同一事件，可能重复工具副作用；`-SkipEvent` 放弃该事件并推进游标。不要多开桥接共享同一 state。当前配置撤销 allowlist 后，尚未执行的 pending 工作会被过滤；已完成回复仍受 IM 当前成员权限限制。

## 普通 Node / Linux 路线

安装 Node>=24.9，然后在本目录 `npm ci --ignore-scripts`（生产运行/模型插件可能需要对应平台的原生依赖）。配置同版本官方 CLI 的 `dshBin` 或使用 SDK 依赖带的 CLI；执行 `node bridge.mjs --config config.local.json --handshake`，再去掉 `--handshake` 持续工作。DSH 的 package-manager操作可能需要本机 pnpm。使用专用系统账户、明确任务目录与执行权限运行。

## 测试边界

`node --test workspace/bridge/test/bridge.test.mjs` 验证过滤、游标、重发幂等、崩溃不自动重跑、锁与附件校验。其中 executor 是明确的测试替身，不能作为真实模型成功证据。真实官方握手命令如上。模型端到端验收需发送 `@dsh 请在任务目录写入 hello.txt，内容 bridge-ok，并汇报`，确认文件、会话轨迹、聊天结果均存在，再重启桥接验证结果不重复；此步骤会调用操作者配置的模型。

本机已有Ollama的额外真实文字实验见 `LOCAL-MODEL-TEST.md`：纯SDK精确回复通过，真实IM回路返回了模型文字但多了@dsh前缀，严格exact-match失败后停止。`run-local-model-smoke.ps1` 可显式复现，使用本地CPU，不加入默认测试、不下载模型、不调用付费API。工具写文件验收仍未执行。
