# 文章与 DSH 一手资料核验

核验日期：2026-11-07（Asia/Shanghai）。微信文章用 PowerShell `Invoke-WebRequest` 读到 `activity-name` 与 `js_content`；网页检索工具打开该链接失败，不等同文章不可访问。下列为自行归纳，无整篇转载。

## 文章对本项目的启发

来源：[Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)，作者署名 DeepSeek Harness 团队。文章明确是工程架构探索，不能视作现成产品功能清单。

- 常驻协调层承接跨入口事件，隔离的执行会话完成任务；用户不需要管理底层 Session。
- 先用确定规则筛选消息，再让模型判断；会话/话题 ID 使后续消息回到对应任务。
- 短摘要与可追踪引用控制上下文体积；完整信息按需读取。
- IM 只输出必要提问和结论；耗时任务不应阻断人继续发消息。
- 计算、持久状态与真实工作机器分开部署；外部监控观察存活与任务进展。

首版落实消息持久化、可补读事件、会话隔离、机器人白名单、异机拉取与简洁结果回传。尚未实现论文式全局 Router/并行 Worker、语义主动触发、跨 GitHub 连续任务图或语义 Watchdog。当前桥接逐任务执行，IM 服务仍持续接收消息并保留待处理事件；不声称已复制完整 Super-agent 系统。

## 官方实现与协议

1. [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：官方开源 Harness，MIT。检出到忽略目录 `environment/tools/dsh/source`，本次 commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。源码仅作核验，未在本机从源码重新构建 Desktop。
2. [官方 Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)：Electron 外壳，内置 CLI，Desktop profile 与 SDK profile 分开；`DSH_HOME` 是产品数据根。现有 Desktop 的私有 loopback HTTP/WS 鉴权并不是通用外部 IM channel API。
3. [官方下载页](https://www.deepseek.com/download/) 的 Windows 链接：[官方 Windows payload](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe)。2026-11-07 返回文件名 `deepseek-harness-0.2.2-rc.1-win-x64.exe`，293425336 字节，SHA-256 `830947f8996dc05d991ca9133fff4d3400073e47b9cfa6507754867e79482b23`。Windows Authenticode=Valid，签名人 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.。解压 NSIS payload 到本项目工具目录，未执行安装器、未改全局 PATH 或已有 `~/.dsh`。
4. [SDK 总览](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md)、[TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[wire protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)：官方跨进程 stdio newline-delimited JSON-RPC。`HarnessClient.initialize` 返回 serverInfo；`DeepSeekHarness.run` 负责收到持久 inbox receipt 后等待 agent idle；`resumeSession` 恢复持久会话；`close` 回收子进程。服务不是自造 webhook。
5. [Python SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)：同一 wire 协议的另一官方实现。本项目桥接用 JS SDK，与 Windows 客户端环境复用语言。

版本必须固定：本次 Desktop/CLI/SDK `0.2.2-rc.1`；官方 CLI `engines.node >=24.9.0`。已使用 Desktop 内置 Electron Node `v24.21.0`。核验时 npm SDK 的 `latest` dist-tag 仍指 `0.0.1-rc.1`，不能直接省略版本。SDK tarball integrity：`sha512-Wvpq8qKnNefXG7aPTQgH5GqPkdAV3ReAzm5cS2cvFMM7EwagDjxdbJE7v1T6KEKJfiLkgf1m/F6KBYWCU073Rg==`。

## 文章对应的 Source 原型

文章“阅读原文”指向 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。该仓库自述研究原型，现成来源为 GitHub 和可选飞书。其 [008 Cookbook](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/008-cookbook.md) 的 `hookq` 是讲解扩展 Source 的虚构 CLI，不应直接配置为真实服务。

要进入该原型，另写 Cordis Source 插件：`inject=['orchestrator']`，注册 `SourceKind`，`sourceContext(...).receive(trigger)`；只有 receive 持久化后推进游标。Trigger 包括稳定 ID、source、threads、actor、human、addressed、at、text、channel、meta。Source 定义 scope、policy、threadContext、幂等 channel.send 与健康监控。文章中的 Thread 比本版 IM conversation 更细；以后增加话题/回复字段后再映射，避免更改已持久化 ID。

本版选择官方 SDK，使另一台机器真正启动 Harness 执行工作；它提供基础通信接缝，不包含原型的全局任务调度。后续可保留现有 IM API，增加 Source 插件复用游标和幂等接口。

## 实际验证范围

- 官方签名 Desktop CLI `--version` 实际返回 `0.2.2-rc.1`。
- `workspace/bridge/run-desktop.ps1 -Handshake` 实际启动官方 SDK profile，返回 `serverInfo.name=deepseek-harness-sdk-runtime`、`version=0.0.1`，读到项目隔离 `environment/tools/dsh/tasks`，正常 shutdown；未发送 prompt，零模型请求。协议服务的版本字符串不是 Desktop 包版本。
- 可靠性测试中的确定性执行器仅验证桥接状态机/重发等，不构成真实模型任务验证。完整真实模型执行需操作者配置自己可用的模型凭据；本次没有借用或猜测凭据。

重启或上下文压缩后，先按根 AGENTS/RESTORE 读取，再读本文件和 `workspace/bridge/README.md`、`DESIGN.md`。
