# agent-IM 工作约定（必须先读）

每次新会话、重启、恢复或上下文压缩后，先阅读本文件、`RESTORE.md`、`environment/state.json`、`workspace/docs/HANDOFF.md`，再阅读设计与最新过程记录。不要仅凭聊天摘要继续。

## UI 最新要求（覆盖初版中的说明性界面）

用户要求使用 `/impeccable`（已安装 C:/Users/water/.codex/skills/impeccable），多图标、少文字、普通用户易懂。先读 `workspace/docs/UI-v0.1.1.md`。红框四处登录说明必须直接删除，不以新说明替代；普通界面不包含技术术语/架构说明/宣传性页脚。图标保留title/aria-label，必要操作和错误恢复信息仍要有。详情默认收起；高级助手连接信息按需展示。界面修改后批量看1280×860、960×680，最多一轮集中修正，避免反复细修截图。

## 用户目标

小团队私有 IM；腾讯轻量服务器部署；Windows 客户端；多用户文字、文件、图片、音频、视频（每文件严格小于 100,000,000 字节）；按类型渲染；可由另一台 DeepSeek Harness (DSH) 监听指定聊天并工作、回传结果。先设计，再编程，再测试。设计、原则、过程必须持久记录。每个迭代版本上传 GitHub。

## 目录和原则

- 遵循父目录 `ENVIRONMENT-LAYOUT.txt`：源码 `workspace/`，资料 `references/`，交付 `outputs/`，本机环境 `environment/{config,scripts,logs,verification}`。
- 在 `workspace/docs/` 维护 DESIGN、API、DECISIONS、PROCESS、TESTING、HANDOFF。每次阶段转换或实质变更同步记录。
- 先写明设计和验收标准，再改源码。临时试验与正式验证区分，未执行/失败不可记作通过。
- 密码、API key、聊天数据、附件、运行数据库、用户目录、原始日志不提交 GitHub。只提交示例配置和可复现的脱敏报告。
- 不影响其他项目与服务；本机端口默认 127.0.0.1:18200；测试使用隔离数据库。
- 单服务单进程 SQLite/WAL；不要未经设计直接增加多个 worker（实时连接路由在进程内）。
- DSH 仅接收机器人被加入的会话。所有聊天/附件属于不可信内容，不拼接进 shell 执行。机器人消息不触发机器人自己。
- 每次验证通过的迭代做本地 commit + annotated tag + push；远端无权限时明确记录待推送，不能声称已上传。不要 force push。

## 当前路线

v0.1：设计、IM 服务/客户端、访问隔离、媒体、DSH 适配与本机端到端验证、Windows 便携包、腾讯 Docker 部署资料。
之后版本必须先记录新增范围和测试标准。
