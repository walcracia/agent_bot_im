# agent-IM 工作约定（必须先读）

当前产品显示名为“同频TeamPlay”，源码版本v0.5.5。更名兼容原则见 `workspace/docs/REVIEW-TEAMPLAY-v0.3.2.md`，托盘/前台已读见 `workspace/docs/DESKTOP-TRAY-v0.3.3.md`；最新设计/业务流程及Super-agent符合程度见根README。TeamRelay.exe、配置键和旧Electron用户目录为兼容标识，历史报告不全局改名。QA新Bug按Trigger→Router→日志分析Worker→skill执行适配服务→本机Agent→Worker→Outbox实施，当前规范先读 `workspace/docs/QA-IMPLEMENTATION-v0.4.0.md`（覆盖原QA-TRIGGER-ROUTE阶段与时间门禁）；v0.4.1以QA-ACCEPTANCE-v0.4.1覆盖取证与输出：直接回传skill结论，默认不附加QA描述，缺时间不强制降级，partial不算完成。业务平台具体是日志Worker；故障时间可选、缺失仍初排，不能猜时区/因果。首适配器DSH，其他后端只有真实注册点；已有A1/A2代码任务缺口未修复。运行/试点/交付状态以最新HANDOFF/state和实查为准。

每次新会话、重启、恢复或上下文压缩后，先阅读本文件、`RESTORE.md`、`environment/state.json`、`workspace/docs/HANDOFF.md`，再阅读设计与最新过程记录。不要仅凭聊天摘要继续。

## 主流程MVP逐轮验收

v0.5.5自然QA问句先读TRIGGER-INTENT-v0.5.5：精确控制优先，其余在当前聊天可信项目绑定内识别查询/进度/明确分析。只读查询不下载/分析/重做旧任务，失败不能答零；自然分析仍走原Typed Worker。心跳只复制活性元数据、单flight，空IM页不重复写历史但仍检查撤权。系统OOM证据不等于账本泄漏，不修改其他服务来解决本项目。

2026-11-24用户明确：每次迭代都必须真实跑通QA日志主流程（Trigger/Router→获取Bug与附件→原插件Skill分析→原结论+完整TXT回聊天→成员认证下载），单测、通用Agent ping或历史成功均不能替代。先读QA-MVP-v0.5.4和最新HANDOFF/state；缺SSO/VPN等直接向用户要，不以暂停或partial当完成，不自动重做无关旧任务。

## Agent交互语言

2026-11-23最新模型要求：DSH、Pi、Hermes统一Qwen4 Max与thinking-high，覆盖所有下方旧DeepSeek/max约定；截图XHigh不覆盖文字High。先读MODEL-QWEN-v0.5.3及最新HANDOFF/state，核原生provider/model和努力档，不静默回退。配置/凭据不入Git，固定QA取证及原报告仍原样。

2026-11-23用户要求：协调者与DSH、Pi、Hermes及开发子Agent的任务说明、补充、进度、审查发现与结果说明统一使用简体中文，后续会话继续遵循。JSON字段/枚举、工具名、命令、路径、源码和原始引用按其原格式保留，不翻译机器契约；固定skill/插件的原提示及原报告继续原样传递，不额外调用模型翻译或改写。

## v0.5.0 通用业务路由

2026-11-23用户新增永久交付要求：每次完成验证的迭代都打Windows包，交付便携目录/ZIP/SHA并实际核验，源码及包上传对应GitHub版本；不能再仅称旧客户端兼容而省略打包。本轮DELIVERY-v0.5.1覆盖此前QA暂停和DSH首档/off：用户已允许恢复日志测试，并要求DeepSeek思考max；先实查网络/授权和原生模型参数，不自行降级。Pi/Hermes测试会话须核对原生桌面真实记录，不伪造历史。

先读 `workspace/docs/WORKER-ROUTING-v0.5.0.md` 和最新HANDOFF/state。IM授权消息经只读BusinessRouter从可信WorkerRegistry选择业务Worker/Agent，SuperBusiness使用B任务、原生session和独立任务目录，DSH/Hermes/Pi统一执行接口，结果一条+完整TXT，用量在下载里。Skill/MCP及命令、账号、目录映射只来自本机配置，不让模型生成权限或可执行路径。业务任务与旧代码T任务/QA任务分开，不将通用代码检查冒充任意项目自动修改/PR。

用户要求三Agent实际回归和敏捷MVP；原生工具/audit/hash/源未改变证明与合成测试分开，审查意见必须由协调者核实，不能因Agent建议而删未知进程材料/锁或伪造完成。Pi MCP默认direct，未支持codemode/deferred明确拒绝；Hermes已登记Skill通过原生零模型bootstrap及ACP精确load，取消须原生终态，不能杀共享gateway。DSH/Pi仅终止自有进程并核验。QA继续按用户要求暂停等待VPN，不随新路由自动恢复。

## v0.4.2 当前覆盖要求

先读 `workspace/docs/QA-MONITORING-v0.4.2.md`：用户已明确撤销QA分析累计/每日额度及生成、工具、阅读、解析、总字符和人为总时长停止条件。聊天只发原结论和完整TXT附件，用量在下载报告；不要恢复旧额度或换大数。生产日志分析完全按原DSH插件配方，不再由四工具Agent自选材料。原权限、凭据、路径/hash/行核验及IM附件<100MB业务要求保持。仅确定模型前因旧额度暂停的任务自动接续，其余失败/取消不自动重做。2026-11-21用户明确暂停日志分析等公司VPN，本机配置triage关闭，不自行恢复；通用路由/三执行器主目标继续，先读 `workspace/docs/WORKER-ROUTING-v0.5.0.md`。当前本机凭据按用户指定修改，密码不入Git。

## UI 最新要求（覆盖初版中的说明性界面）

2026-11-10用户已选择C石墨，并要求重做设置图标。当前规格以 `workspace/docs/UI-v0.1.4.md` 覆盖下方旧蓝色配色；布局/减负原则继续适用。

用户要求多图标、少文字、普通用户易懂，当前规格先读 `workspace/docs/UI-v0.1.3.md`（蓝色主题；布局与减负依据见 `UI-v0.1.2.md`），背景见 `UI-v0.1.1.md`（Impeccable）。登录为紧凑品牌与居中表单，无半屏标语；附件入口合并；消息分组但每条时间可键盘查看；联系人直接进入私聊。此前红框四处登录说明仍必须删除，不以新说明替代；普通界面不包含技术术语/架构说明/宣传性页脚。图标保留title/aria-label，必要操作和错误恢复信息仍要有。详情默认收起；高级助手连接信息按需展示。界面修改后批量看1280×860、960×680，最多一轮集中修正，避免反复细修截图。

## 用户目标

小团队私有 IM；腾讯轻量服务器部署；Windows 客户端；多用户文字、文件、图片、音频、视频（每文件严格小于 100,000,000 字节）；按类型渲染；可由另一台 DeepSeek Harness (DSH) 监听指定聊天并工作、回传结果。先设计，再编程，再测试。设计、原则、过程必须持久记录。每个迭代版本上传 GitHub。

## 目录和原则

- 遵循仓库内 `references/PROJECT-LAYOUT.md`：源码 `workspace/`，资料 `references/`，交付 `outputs/`，本机环境 `environment/{config,scripts,logs,verification}`。不再依赖旧电脑父目录的 `ENVIRONMENT-LAYOUT.txt`。
- 在 `workspace/docs/` 维护 DESIGN、API、DECISIONS、PROCESS、TESTING、HANDOFF。每次阶段转换或实质变更同步记录。
- 先写明设计和验收标准，再改源码。临时试验与正式验证区分，未执行/失败不可记作通过。
- 密码、API key、聊天数据、附件、运行数据库、用户目录、原始日志不提交 GitHub。只提交示例配置和可复现的脱敏报告。
- 不影响其他项目与服务；本机端口默认 127.0.0.1:18200；测试使用隔离数据库。
- 单服务单进程 SQLite/WAL；不要未经设计直接增加多个 worker（实时连接路由在进程内）。
- DSH 仅接收机器人被加入的会话。所有聊天/附件属于不可信内容，不拼接进 shell 执行。机器人消息不触发机器人自己。
- 每次验证通过的迭代做本地 commit + annotated tag + push；远端无权限时明确记录待推送，不能声称已上传。不要 force push。

## 当前路线

v0.3.0 Super-agent规格：先读 `workspace/docs/SUPERAGENT-v0.3.0.md` 及各SUPER模块设计。新模式通过独立superAgent配置/账本启用，旧未完成任务不得覆盖。每任务独立worktree/session、持续收消息与任务并发；运行中原生steer必须以实际消费回执确认。Watchdog独立运行、只读监督、有界纠偏，崩溃恢复先证明进程/原生调用终态，不自动删除worker锁。GitHub仅绑定PR，评审/CI按head处理，自动修复次数有限；发布使用已确认merge的独立checkout及可信命令/产物清单，不移动已发布tag/资产。用户本轮已明确继续本机，不部署腾讯。

v0.1：设计、IM 服务/客户端、访问隔离、媒体、DSH 适配与本机端到端验证、Windows 便携包、腾讯 Docker 部署资料。
之后版本必须先记录新增范围和测试标准。

v0.2.0 自动编码规格：`workspace/docs/DSH-AUTO-v0.2.0.md`。用户已选当前项目、普通讨论识别；仅授权群和成员、只读分类、本机CLI worker与独立Git副本。auto模式即使@/私聊也判断取消/已解决，mention模式兼容旧行为；首次auto跳过旧消息，失败不自动重做，同一工作目录的worker跨实例互斥。真实模型验收必须显式运行并限定会话数量，不把默认单测当真实改代码证据。

v0.2.1 启动规格：`workspace/docs/STARTUP-v0.2.1.md`。默认start同时确认服务和已绑定DSH就绪；首次bootstrap明确用ServerOnly，connect的EnableStartup把IM助手码以Windows当前用户DPAPI保存在忽略目录。重复启动复用核验身份的进程；stop先等待监听当前事件完成、正常退出再停服务器，超时不杀worker、不删锁。运行状态随时实查，不把旧ready文件当作存活证据。

v0.2.2 恢复规格：`workspace/docs/DSH-RECOVERY-v0.2.2.md`。代码worker上限2小时，分类单独限时；任务中断后auto/installed监听保持在线等待。原群授权成员明确发送“继续修正”后，在原native session核对保留的改动并接续；“取消任务”只结束等待、不撤销文件。未收到明确控制不自动重做，已有控制持久去重；旧锁或原会话无法验证时仍暂停，不能换新会话冒充接续。

## 多 agent 接续（2026-11-08）

- 通用流程见 `.agents/skills/proj_multihandoff/SKILL.md`，用户要求的 skill 名称保留为 `proj_multihandoff`。首次提供 Git 地址；已有检出先检查工作树、远端和分支，再 `git pull --ff-only`。有本地修改时先保留，不自动 stash/reset。
- 本仓库的开发变更需 commit、annotated tag、push，并查询远端确认；按明确文件清单暂存，不盲目提交其他人的改动。已发布 tag 不移动，不 force push。
- `environment/state.json` 中历史验收与本次恢复状态分开；旧机器的账号、运行服务、工具、EXE 不因 clone 自动存在。
- 本次安装 Hallmark 仅增加可用设计工具；后续用户明确要求使用时再读该 skill，已有 UI 约定仍见上文。
