# DSH 桥接设计（2026-11-07，编码前冻结）

## 接缝与范围

采用官方 `@deepseek-ai/dsh-sdk-client@0.2.2-rc.1`，经 stdio JSON-RPC 启动官方 CLI 的 `sdk` profile。Windows 本机用官网下载的 Desktop payload 中的 Electron Node 模式和 CLI；另一台机器可用 Node>=24.9 和同版本 npm CLI。独立 `dshHome`、明确 executor `cwd`。不连接 Desktop 私有 HTTP/WebSocket，不修改已有 Desktop profile，不把示例 Source 协议当产品 API。

IM 消息 GET `/api/agent/events` 按游标获取。服务器成员授权外，桥接再检查会话和执行发送者 allowlist；仅私聊或精确 `@dsh` 触发。其他人/群消息可被监听但不触发。空 allowlist 不执行。稳定 `sessionId` 每会话隔离，重启用 `resumeSession` 恢复；不把不同聊天混进同一会话。

## 可靠性

单进程本地文件锁；任何已存在的锁都拒绝启动，不自动清理 stale 锁，避免读旧 PID 后误删并发新锁的 TOCTOU 竞争。只有人工确认桥接和 Harness 子进程均已退出后，才能删除确切锁文件；状态文件保持原样。JSON 状态用临时文件原子替换。事件阶段：`pending → started → reply → acknowledged`，结果/回复在发 HTTP 前持久化，IM `client_id=dsh-{event_id}-{part}` 保证网络重试不重复。只有忽略事件或回复全部成功后推进 cursor。执行中崩溃无法证明工具是否产生副作用，恢复后标记 uncertain，停止并要求显式 `--retry-event ID` 或 `--skip-event ID`；不能谎称分布式 exactly-once。发送失败只重发已存结果，不重跑 Harness。正常模型错误回传失败状态；不自动重复模型工作。

## 输入和权限

文字和媒体元数据序列化为 JSON 内容块，绝不拼接 shell。附件仅从本 IM origin 取回，流式计数与 SHA-256 校验；先解析 operator cwd 的 realpath，再直接在其中 mkdtemp 创建不可预测私有目录，不复用可预置链接的 incoming/event 静态目录。payload 用 wx 独占创建，不覆盖已有链接或文件，目录/文件 realpath 均须在已解析 cwd 内；失败仅精确清理本次路径。此措施防止预先放置的链接导致附件覆盖 cwd 外文件，但不是对同 OS 用户恶意并发进程的真正 sandbox；执行隔离仍需专用系统用户或容器。本地路径和原始名称作为不可信数据提供给模型。小型栅格图可走 SDK image block，其他媒体文件提供本地路径。执行用户、会话、任务目录由配置控制，不从消息改写。SDK 外部审批请求一律拒绝并在聊天中报告；结构化用户问题转成聊天消息后取消当前问题等待，后续用户消息可继续。模型凭据仅环境或独立 DSH home，不进配置示例/日志。

## 验收

1. 真实官方 Desktop CLI initialize handshake 返回 `deepseek-harness-sdk-runtime`；读会话工作目录；shutdown，零 prompt / 零模型请求。
2. 单元验证过滤、自发 bot 回路排除、游标恢复、结果重发幂等、started 崩溃不自动重跑、附件大小/哈希。
3. IM 联调必须区分 HTTP真实服务+测试执行器和真实 Harness 模型任务。没有模型凭据时仅把真实 handshake 记为通过，模型执行保留未验证。
4. 提供可重复本机部署、handshake、持续桥接命令与 operator 处理不确定事件的方法。
