# 同频TeamPlay

小团队私有聊天工具：Windows 客户端，支持私聊、群聊、文字、图片、音频、视频和文件。每个附件严格小于 **100,000,000 字节**。团队可以在授权群里讨论需求，让 DeepSeek Harness（DSH）在指定代码项目中执行、测试，再把结果送回聊天与 GitHub。

当前源码版本 **v0.5.5**。授权聊天的自然语言请求可由AI选择已登记Worker及DSH/Hermes/Pi执行器，结果和完整报告回原聊天。QA支持自然问句查近况和进度，查询与日志分析分别处理。DSH、Pi、Hermes统一使用Qwen4 Max、High思考；每轮完成都生成并验证Windows便携包。模型与原生校验见 [v0.5.3设计](workspace/docs/MODEL-QWEN-v0.5.3.md)，交付状态以最新HANDOFF/state为准；开发运行见 [workspace/README](workspace/README.md)，重启或换机器先读 [RESTORE](RESTORE.md)。

协调者与DSH、Pi、Hermes的任务、进度及结果说明统一简体中文；JSON字段/枚举、命令、代码及原始引用保持原样。约定见[中文交互设计](workspace/docs/AGENT-LANGUAGE-v0.5.2.md)。

Windows包：[v0.5.5 Release](https://github.com/walcracia/agent_bot_im/releases/tag/v0.5.5)。完整解压后运行`TeamRelay-win32-x64/TeamRelay.exe`；包只含客户端，后台仍用仓库的`environment/scripts/start.ps1`。构建和验收见[v0.5.5报告](outputs/VERIFICATION-v0.5.5.md)。

在已跟踪项目的聊天里，可以直接说：

| 你说 | 同频会做什么 |
| --- | --- |
| T13JVP最近没有bug么 | 查询近7天新增、当前未关闭数量及最近编号。 |
| 查一下T13JVP近3天的缺陷 | 查询指定天数，不启动日志分析。 |
| 日志分析到哪一步了 | 显示这个聊天已有分析的进度。 |
| 能帮我分析一下T13JVP-229吗 | 读取该编号和附件，走原插件Skill分析，回原结论和完整报告。 |

明确问句直接查业务数据；其他QA表达由只读AI识别意图，再在当前聊天已授权项目内执行。不清楚项目或缺分析编号时会追问。查询不会重做旧失败任务，失败也不会答成“没有Bug”。支持的时间范围是最近N天，省略时为7天；尚不支持的日历范围会请你说明天数。设计和验收见[自然问句分流](workspace/docs/TRIGGER-INTENT-v0.5.5.md)。

## 产品定位：统一业务入口与任务路由中心

同频的目标是让团队在聊天里提出需求，或由业务系统的变化触发任务；后台识别要做什么、选择合适的Worker，再调用该业务需要的Agent、Skill与MCP，把结果和文件送回原聊天。日志分析、代码修改、业务查询可以接成不同的业务插件，各自保留自己的执行流程。普通聊天仍直接通信，不需要每条消息都调用模型。

| 角色 | 职责 |
| --- | --- |
| IM | 团队统一入口，保存讨论、材料和结果。 |
| Trigger | 把聊天请求、QA新增Bug等变化转成可追踪的任务事件。 |
| Router | 识别业务与任务归属，选择已注册、已授权的Worker，关联已有任务或建立新任务。 |
| Worker | 对一项业务负责：准备输入、调用执行能力、收集结果和文件，再交回聊天。日志分析Worker与代码Worker可以有不同流程。 |
| Agent | 执行任务的智能体运行环境，例如DSH；不同Worker可接不同Agent，不要求每个任务同时启动多个Agent。 |
| Skill | 业务的做事流程、规则和配套脚本。日志业务按原DSH插件配方执行，不由Router另写一套诊断流程。 |
| MCP | 业务系统的数据和操作接口，例如读取QA缺陷及附件；可供来源监听或Worker使用。 |

```mermaid
flowchart LR
  Input[聊天请求 / 业务变化] --> Trigger[Trigger]
  Trigger --> Router[Router：识别业务与任务]
  Router --> Log[日志分析Worker]
  Router --> Code[代码Worker]
  Router --> Other[登记的业务Worker]
  Log --> LogRecipe[原DSH插件：Skill与模型调用]
  Code --> CodeAgent[代码Agent与项目工具]
  Other --> Capability[DSH / Hermes / Pi + Skill / MCP]
  LogRecipe --> Result[业务结果与文件]
  CodeAgent --> Result
  Capability --> Result
  Result --> Chat[原聊天]
```

**当前实现范围。** 新业务入口通过只读AI和可信能力注册表动态选择Worker与可用Agent，使用独立B编号、任务目录及原生会话。DSH、Hermes、Pi已真实接通，QA先识别自然查询或分析意图，再使用专用typed规则和完整原插件流程；OpenCode未实现。管理员登记用途、输入输出、可选Agent和Skill/MCP资源，模型不能自行安装插件、增加执行器、拼接宿主命令或扩大权限。

插件化和多Agent是扩展方式；持续接收补充、保存任务身份、恢复执行和把结果可靠送回团队，仍是这里落实Super-agent思想的一部分。以下QA流程说明当前如何触发、归属和执行，后文的编码流程与审计保留其实际能力边界。

模型与执行器的选型依据见[2026-11-23能力调查](references/RESEARCH-MODELS-AGENTS-2026-11-23.md)：公开测量、运行器功能和业务选型建议分别标明，当前注册分工仍以本机配置为准。

## 通用业务协作

授权IM中三独立自然语言请求已真实跑通：收款核对→Pi，会议待办→Hermes原生文档Skill，代码片段检查→DSH；各回传一条原结果+完整TXT，成员下载内容/hash通过。普通短问候不调用模型，已存在任务的补充保留原Worker/Agent与会话。完整用量留在下载里。

| 执行器 | 已核实的原生能力与本机分工 |
| --- | --- |
| DSH | 独立headless会话、工作目录锁、Skill和stdio MCP；原DSH日志配方与代码工具。 |
| Pi | RPC、精确session恢复、显式Skill/MCP、settled/stop/idle终态；结构化数据核对和文件任务。 |
| Hermes | ACP及原生取消，已登记Skill零模型bootstrap后精确load；文档待办、引用和未明确字段保留。 |

后台使用CLI/原生协议，desktop继续可手动使用。Hermes的执行所有权在原生gateway，关闭客户端不能当作任务已停止；适配器等待原生取消终态。工作目录隔离不等于OS沙箱。通用代码检查针对给定材料，已绑定项目worktree/PR仍由旧代码Worker维护，不宣称任意项目自动修改/发布已经打通。

扩展与恢复见[通用路由设计](workspace/docs/WORKER-ROUTING-v0.5.0.md)。本机配置的superAgent.business登记workers/agents/workerResources；能力描述和可用候选参与AI选择，命令、MCP凭据和资源映射不进入Router提示。三Agent原生回归、失败与修正见[v0.5.0验收报告](outputs/VERIFICATION-v0.5.0.md)。

DSH、Pi、Hermes及DSH业务路由/日志调用/显式回归统一Qwen4 Max、`reasoningEffort=high`。各原生provider标识可不同，模型必须是真实`qwen4-max`；新建与恢复均明确选择并校验，不支持时明确报错，不静默降档。日志原插件取证和system/user保持原样；思考与正文使用原生模型目录的输出容量，旧配方的输出值另留审计。没有恢复分析次数或阅读额度。

Pi会话通过原生共享home的`sessions`登记任务目录，保留原JSONL和会话ID；任务命名为“同频 · 任务ID”。v0.5.3中文实测可查看：DSH“检查切片求和漏算末项”、Pi“同频 · B000004”、Hermes“同频 · B000007”。Pi桌面在“项目”搜索“同频”；Hermes用Ctrl+K搜索“同频”，或在“会话→全部”查找。Hermes默认侧栏隐藏tool/acp，只有tool来源会列入“自动化”，来源不被伪装成人工聊天。原生账号和会话均在本机，不随Git或Windows包分发。

## Windows 托盘与新消息

最小化仍留在任务栏；关闭窗口后收到托盘，继续接收消息。点击托盘图标回到聊天，右键可“打开同频TeamPlay”或“退出”。后台新消息让托盘未读标记交替闪动，并请求Windows任务栏闪烁；回到窗口停止闪烁，其他聊天的未读继续保留。首次登录历史未读、自发及重复消息不重复提醒。实际图标位置/任务栏动画由Windows控制。

窗口在后台、最小化或托盘时，当前聊天也不会被自动标为已读。退出聊天账号会清除桌面提醒；退出客户端不停止独立服务器/DSH。规格与验证见[托盘设计](workspace/docs/DESKTOP-TRAY-v0.3.3.md)和[v0.3.3报告](outputs/VERIFICATION-v0.3.3.md)。

## QA 新 Bug：自动触发、路由与日志分析

这里的 **Trigger → Router** 具体指“后台定时去QA读取Bug，把变化交给正确的分析任务”，这一段已经实现，并非要求成员手动把所有问题转发进群。启用后，后台默认每 **60秒** 扫描显式绑定的QA项目，读取缺陷及附件清单；关闭聊天窗口不会停止独立后台。配置入口为 [config.super.example.json](workspace/bridge/config.super.example.json) 的 `superAgent.triage`，操作见[桥接说明](workspace/bridge/README.md)。

```mermaid
flowchart TB
  QA[每60秒读取绑定QA项目] --> Baseline{该绑定已有完整基线?}
  Baseline -->|没有| SaveBaseline[完整扫描后保存历史清单，不分析旧Bug]
  Baseline -->|已有| Change[识别新增Bug、附件变化、更新或关闭]
  Chat[授权群：问题编号、重分析或补充] --> Trigger
  Change --> Trigger[Trigger：来源、项目、问题、结果群及版本持久入账]
  Trigger --> Route[只读Router：新建、关联、补充、停止或忽略]
  Route --> Task[统一T任务号与输入版本]
  Task --> Worker[日志Worker：读取并校验本问题附件]
  Worker --> Recipe[完整原DSH插件配方：解析、回读、关键行、原提示词]
  Recipe --> DSH[DSH直接调用当前指定模型]
  DSH --> Report[保存模型原五段报告与实际用量]
  Report --> Outbox[Outbox：核验当前版本和群权限，幂等发送]
  Outbox --> Result[绑定结果群：一条结论消息加完整报告TXT]
```

### 已实现的来源与路由行为

1. **首次只建立基线。** 必须完整读完项目分页及附件列表，才提交基线；历史Bug不会被当成新增Bug批量分析。绑定重新启用时也先重建基线，不补跑停止跟踪期间的问题。扫描失败保留旧检查点并退避，不把半轮扫描记成成功。
2. **新增Bug自动入队。** 后续发现尚未见过的未关闭问题，生成 `issue.created` Trigger。Router在绑定范围内创建 `log-triage` 任务；已有同一问题任务则关联原T号。路由只决定归属，不调用模型诊断、不把QA内容路由到代码修改或发布。
3. **新附件回到原问题。** 已有任务的问题增加附件或补充内容，产生变化Trigger，关联原T号；确有输入变化才推进新版本。没有日志时可等待补充，日志到达后再继续。基线中的历史Bug若从未建立分析任务，仅补附件目前不会自动新建任务；先在群里贴编号即可建立分析与关联。
4. **群里也能触发。** 授权成员发送 `DEMO-42` 或 `分析 DEMO-42`，后台精确读取该绑定项目中的问题；未建任务则创建，已有且材料未变则复用原结果。明确发送 `重新分析 DEMO-42` 才请求再次分析；`#T000001 问题说明 ……` 可补充现象，日期、时间和日志时区也可补充到原任务。
5. **关闭与取消会停止后续工作。** QA关闭事件关联已有任务并请求停止；聊天支持 `取消任务 #T000001`、`任务状态 #T000001`、`继续分析 #T000001`。未知终态的执行不会自行重做。

Trigger身份包含来源、项目、问题、绑定结果群和内容版本。缺陷快照与附件ID形成稳定哈希；重复扫描和重复Trigger不会重复建任务。Trigger与来源检查点在同一事务保存，同一问题在不同项目或群里不会混并。QA身份独立于IM成员，不伪装成人类消息，机器人回话也不会再次触发自己。

启用需要 `triage.enabled=true`、允许的QA读取身份和明确的项目→结果群绑定；助手必须在结果群内，群与成员仍受部署配置白名单约束。只有预配管理员、且显式打开 `allowChatProjectBinding` 后，才可在授权群发送 `跟踪项目 DEMO` / `停止跟踪项目 DEMO`；项目代码须精确且唯一匹配，同一QA项目不能借聊天命令改投另一群。日志、模型或普通成员不能更改这些绑定。

实际入口：[QA Source](workspace/bridge/qa-source.mjs)产生变化，[SuperTriage](workspace/bridge/super-triage.mjs)持久接收及关联，[typed Router](workspace/bridge/triage-route.mjs)确定日志任务归属，[SuperCoordinator](workspace/bridge/super-coordinator.mjs)负责执行与Outbox。QA目前没有可靠事件游标或已接通的Webhook；60秒是默认轮询间隔，不是实时推送保证，扫描间创建又删除的问题可能无法捕获。

### 日志执行：完整对齐原DSH插件配方

本轮最新执行规范见 [QA-MONITORING-v0.4.2](workspace/docs/QA-MONITORING-v0.4.2.md)末节。日志Worker提交完整校验材料，按原DSH插件配方组织分析：完整解包目标、固定skill CLI和相同 `windowArgs`，保留完整 `verdict/findings/suggestions`；按原findings顺序回读上下文，再独立扫描原 `filesUsed` 的关键行。标准 `mid` 档使用原配方的44个证据块、60个关键块、三份技能文档、`compactVerdict` 及原system/user文本。这些是原插件的材料组织方式，不是IM额外施加的会话额度。

执行链路为 **完整原插件配方 → DSH宿主 `llm.prepareCall/stream` 直接调用当前指定模型 → 保存原五段报告**。本轮按用户最新要求使用Qwen4 Max、`high`思考，覆盖旧DeepSeek/max及旧插件首档/off；材料与提示原样保留，不再让“四工具Agent自选少量材料＋八字段JSON提示”替代原插件流程，也不增加第二个模型改写结果。若内部兼容结构仍用八字段，只做原报告标题、段落和真实行引用的确定性映射。原插件的HTTP路由、登录和清理逻辑不移入IM，不修改用户原DSH安装。

默认编号分析保持原插件的空现象输入；QA标题和描述留在来源账本，只有聊天明确补充的“问题说明”才作为现象参数。故障时间可选，参数按原配方处理，不由宿主改写责任方、置信度或主要因果链。材料路径、hash、真实行引用、凭据隔离和当前任务权限继续核验；不把参考截图结论写入代码或提示词。

累计/每日分析数、模型调用、工具阅读次数、累计字符及人为分析总时长不再作为停止条件，用量仅统计。旧额度账本保留作历史与幂等记录；只自动接续确认模型尚未启动、且仅因旧额度暂停的任务，不自动重做其他失败或已取消任务。模型及操作系统的实际能力仍属于运行条件。

**验收状态单独记录。** 新配方的整包CLI及三档system/user逐字对比已通过；此前四工具Agent会话完成、历史`partial`或传输通过，不能证明分析等价。v0.5.1历史验收：2026-11-23用户允许恢复后已重新完成QA登录及授权读取，沿原检查点恢复已绑定项目监听，原插件整包+DeepSeek/max真实正向验收已完成：一次实际请求、原提示逐字一致、一条原结论及完整TXT认证下载/hash均通过。v0.5.4已另外真实完成当前Bug双附件、原插件Qwen4/High报告及认证下载，见[本轮验收](outputs/VERIFICATION-v0.5.4.md)。历史失败见[v0.4.2报告](outputs/VERIFICATION-v0.4.2.md)，当前结果见[HANDOFF](workspace/docs/HANDOFF.md)。

### 每轮迭代的QA主流程验收

QA日志业务是每轮软件迭代的必过项：真实授权读取Bug和附件，经聊天Trigger/Router、原插件Skill与当前Qwen4 Max/High完成分析，再确认聊天仅一条原结论+完整TXT、成员认证下载的原文/大小/SHA正确。单测、连接ping、旧版本收据或paused/partial不算本轮通过。原插件保存PNG但不做OCR，不另加视觉分析流程。

开发者显式运行`environment/scripts/verify-qa-live.mjs --live --send`，提供当前本机config/state/accounts-file、已授权任务ID、忽略output和原安装plugin路径；消息只触发一次。完成后同参`--live --check`只核验不重跑模型，生成与当前产品版本/运行源指纹绑定的`qa-live-receipt.json`。`deliver-windows.ps1 -QaReceipt <该收据>`会重读原生证据、附件/报告hash再允许打包；旧版本、改过源或缺阶段均拒绝。离线`verify.ps1`继续不调用模型。具体范围见[QA-MVP-v0.5.4](workspace/docs/QA-MVP-v0.5.4.md)。

### 聊天只展示结论，完整报告下载阅读

每个完成的Bug只发布 **一条带附件消息**：问题编号、原报告【结论】段及其责任方/置信度，附件为完整 `报告.txt`。依据、时间线、其他可能、下一步及实际用量小报表都在下载文件中；`report.json` 内部保存，不另发。正常已收到、进度和独立用量消息不再占聊天位置；真正缺材料或发生错误时仍提供必要信息。

报告先保存再进入Outbox，丢失确认只重发同一正文和附件，不重新分析。新材料以新输入版本接续；取消、解绑、成员或机器人被移出、过期结果及409冲突会拦住相应发送。下载继续使用IM原有成员认证与每附件严格小于100MB的约定。原报告、完整解析结果、模型输入哈希及实际用量只留在忽略的任务目录；真实项目、群、缺陷、日志、下载地址和认证不提交Git。

## 是否符合文章的 Super-agent 概念

**符合主要架构思想，已实现单项目团队编码的核心结构；自动交付仍有两项P1缺陷，上下文等能力也只是部分实现。** 不能据此认为已具备可直接无人值守的可信自动发布。这个判断结合源码和远端已保留审计，不代表官方认证，也不意味着所有模型、任务规模或长期运行场景都已验证。

对照的是 DeepSeek Harness 团队的[《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)（2026-10-31），以及文章链接的[官方研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)。文章讨论连续、高效、主动、持久的工作方式；原型明确属于研究探索。以下是本项目对这些思想的实现判断，不能把原型的模拟评测当成本项目的真实代码质量证据。

| 核对项 | 当前判断 | 源码中的实际行为与边界 |
| --- | --- | --- |
| 连续：聊天到代码评审保持同一任务 | 核心机制存在，有交付窗口缺陷 | IM 需求、绑定 PR 的反馈沿任务编号、工作副本和原生会话接续；重启保留账本。但交付期间新增补充可能已确认却未执行。 |
| 高效：接收、判断、执行相互分开 | 已实现核心机制 | 控制器持续收消息，按批调用只读 Router；每任务 Worker 独立执行，默认最多两项并行。常驻的是控制器进程，Router 每批新调用，不能声称它永久记住全部讨论。 |
| 主动：普通讨论也可引发核查 | 有条件实现 | 显式启用主动核查及可信交付后，可静默调查普通缺陷讨论；正常路径没有可靠结果时保持安静，重启仍可能误发通知。并非任何群、任何成员都能触发。 |
| 持久：状态与执行环境分离 | 已实现基础能力 | 事件、输入、任务、原生消费回执、输出和交付阶段持久保存；可接独立工具 daemon。仍是单控制器的本地持久状态，不是分布式高可用或无限长期记忆。 |
| 运行中接纳新输入 | 已实现，抢占与交付有边界 | 使用原生 `agent.steer`，保存原生消息与序号回执；Worker运行/收尾期的迟到输入进入同会话下一轮，交付期仍可能遗漏。回执证明接纳，不证明模型已正确遵循，也不保证长工具立即停止。 |
| Thread、引用与按需召回 | 部分实现 | 有消息/任务/PR/结果引用图和 Worker 的 `context_read` 分页；没有完整通用订阅引擎、全局上下文预算或历史自动压缩。 |
| 独立语义监督 | 已实现受限版本 | 独立进程和只读模型会话判断偏离、停滞与循环，有界纠偏或暂停。没有开放模型自行改系统规则/权限；与文章全工具监督方案存在刻意差异。 |

文章中的实时共同操作、跨实例协作、组织级长期记忆仍涉及探索问题；本项目不宣称已经完成。自动合并、自动发版是这里增加的交付能力，不能仅凭这些功能判断是否为 Super-agent。概念来源可继续读官方[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)与[架构文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)。

## 团队、IM、DSH 与代码项目怎样协作

| 参与者 | 负责什么 |
| --- | --- |
| 团队成员 | 提出问题、补充要求、查看进度、判断结果是否满足业务需要。 |
| 管理员/项目维护者 | 创建账号与助手，绑定允许的群、成员、项目、测试及交付策略，处理暂停和权限问题。 |
| 同频TeamPlay | 保存聊天与附件，控制访问，提供桌面操作入口，把授权事件交给控制器并展示简短结果。 |
| 控制器与 Router | 持续接收事件、识别新任务或已有任务输入、调度并发。Router 只读分类，不直接改代码。 |
| DSH Worker | 在每项任务自己的 Git 工作副本、分支和原生会话中理解需求、修改代码、执行工具与测试。 |
| Watchdog | 作为外部监督者查看进度证据，必要时提出一次纠偏、暂停或通知人员。 |
| GitHub 与交付器 | 保存可审查的差异、评审、检查及版本资产；按可信策略确认准确代码版本后合并和构建。 |

```mermaid
flowchart TB
  Team[团队成员] --> IM[同频TeamPlay Windows 客户端]
  IM <-->|消息与附件| Server[IM 服务：单进程 FastAPI]
  Server --> DB[(SQLite WAL 与附件目录)]
  Server -->|授权聊天事件| Controller[持续运行的控制器]
  GH[GitHub：PR、评审、检查、Release] -->|绑定 PR 的反馈| Controller
  Controller --> Router[只读 Router：任务识别与归属]
  Router --> Controller
  Controller --> W1[DSH Worker A：独立副本与会话]
  Controller --> W2[DSH Worker B：独立副本与会话]
  Controller <--> Ledger[(任务账本、输入回执、引用图、输出队列)]
  Watchdog[独立 Watchdog] -->|有界纠偏 / 暂停| Controller
  Controller -->|只读进度快照| Watchdog
  W1 --> Delivery[可信测试与交付器]
  W2 --> Delivery
  Delivery --> GH
  Controller -->|简短进度、结果与链接| Server
```

IM 服务器负责通信，DSH 执行环境负责代码工作，两者可分别部署。Windows 聊天客户端不包含服务器或 DSH。项目绑定决定 Worker 操作哪个仓库，群里的一条消息不能改绑项目或放宽权限。

双击 `TeamRelay.exe` 只打开Electron客户端，不会执行后台 `start.ps1`；统一启动IM/DSH/监督由脚本入口完成，关闭窗口不等于停后台。Tauri尚未迁移。

## 一项需求从讨论到交付

1. **管理员先绑定。** 创建助手并加入指定聊天，允许派任务的成员也需明确配置。选择一个项目及独立工作副本，配置 DSH、可信测试和 GitHub 策略。首次启用自动识别时跳过旧消息，避免历史讨论突然开始编码。
2. **成员正常讨论或明确交办。** 服务保存消息，控制器持续补读。先按群、成员与机器人身份过滤，再交给只读 Router 判断新任务、补充、状态、停止、继续、忽略或主动核查。机器人自己的回复不会再次触发自己。
3. **任务入账并取得编号。** 例如 `T000001`。任务持有来源引用、需求、状态、工作副本、分支和原生会话映射。归属不明时要求指定编号；新任务排队，同一任务不重入。
4. **Worker 执行。** 建立独立 `codex/super/<任务号>` 分支与 worktree，调用已安装 DSH。默认最多两项并行，每次 Worker 调用默认上限两小时；同一任务接续可以产生多轮，具体由本机可信配置决定。代码工作不直接修改团队维护者正在使用的主检出。
5. **成员继续参与。** 输入和控制先持久保存，运行中送入原任务；群里可得到简短状态。交付阶段新增补充仍有遗漏窗口，已确认不等于已消费。模型答复、测试与真实差异分别记录，不能只靠“已经做好”的文字决定成功。
6. **交付器验证并关联 PR。** 启用 GitHub 交付时，使用固定仓库和命令，核对验收运行前后源码、索引与 HEAD。但测试脚本本身仍可被 Worker 提前改弱，这个检查不能保证最低可信验收门槛。绑定 PR 的有效评审与失败检查回到原任务，有界修正；旧 head 的反馈不能替当前代码放行。
7. **按策略合并。** 默认评审策略要求配置的检查和可信评审。维护者也可显式选择 `verified-tests`，以非空固定测试及配置的远端检查为门禁。该策略在旧机器曾启用，新 clone 不会自动取得授权或凭据。
8. **按需发布并通知。** 启用 `verified-tests` 及相应基线/版本策略后，交付串行同步最新基线并复验、维护顺序版本；合并后从指定 merged commit 的独立副本开始构建，上传配置清单中的文件并核对哈希。构建后的HEAD未充分重验，仍有来源核验缺口。已发布 tag 和资产不覆盖；发布失败单独保留阶段，但软件内尚缺显式核验后续发入口。结果通过可重发的输出队列送回群里。

未启用 GitHub/合并/发布时，任务仍可执行并返回结果；后续交付由维护者审查。这些步骤是可配置流程，不表示新机器开箱后就会自动提交和发布。

## 补充、停止、继续与主动核查

| 团队操作 | 系统行为 |
| --- | --- |
| “把按钮改为蓝色 #T000001” | 为已有任务保存补充；Worker运行/收尾期尝试原生 next-step 或原会话下一轮；交付期间收到的输入仍有遗漏缺陷。 |
| “任务状态 #T000001” | 通过明确状态命令读取，不因此启动编码。 |
| “取消任务 #T000001” | 停止可确认拥有的执行进程，保留已有代码和记录；取消不等于回滚。无法确认终态时保持不确定状态；remote-tools在途写入仍可能取消后落盘。 |
| “继续修正 #T000001” | 同群授权成员明确接续，核验原副本、会话与锁后继续；缺少原会话时暂停处理。 |
| 关闭但未合并的 PR 后明确继续 | 沿原任务身份接续，交付时按授权重开，保留原改动。 |
| 已合并任务再收到新修正 | 建立带父任务引用的新任务，避免改写已交付结果。 |
| 普通缺陷讨论、没有明确交办 | 只有主动核查及可信交付已启用时才可静默调查；正常路径有效证据/交付出现后再通知，重启仍可能误发中断通知。已解决或取消的讨论应忽略。 |

明确编号控制有快速通道。语义归属仍由模型判断，多任务或较老任务建议带编号。任务执行期间仍接收其他消息，取消一项不应结束另一项。

Watchdog 具有独立进程、心跳和单独的只读模型会话：既检查控制器存活，也根据目标、差异、测试和工具进度判断是否偏离或空转。同一任务同一轮自动纠偏最多一次，再次异常转为暂停；模型失败有预算和冷却。不确定副作用、旧锁、原会话丢失不会靠换会话或删除锁掩盖。控制器重启只对可证明的进程身份和终态恢复，不承诺所有崩溃都能无人值守完成。

## 上下文与媒体的实际边界

引用图把消息、聊天、任务、PR 和结果连接起来；Worker 用任务作用域的 `context_read` 按页读回。但当前还有以下缺口，应作为后续版本范围设计和验收：

- **上下文总量未严格受控。** `task.inputs` 全历史仍直接进入 Worker 每轮 prompt，链接摘要也未完整计入字符预算；没有无限历史自动压缩。聊天节点正文是标识信息，不是自动生成的近期讨论摘要。
- **Router 的召回有限。** 每次语义判断只看同群最近80个任务，内联最近12个任务引用；Router 未挂载 Worker 的召回工具。很老但活跃的任务可能不在语义候选中，显式 `#任务号` 仍可定位全部同群任务。
- **Thread 范围较窄。** 目前通过聊天归属、任务引用和绑定 PR 连接来源，没有通用多对多订阅、组织级知识或跨实例 A2A 协作。
- **多条补充的严格先后未保证。** 当前 inbox 按文件枚举顺序送入，未显式按事件序号排序。覆盖型连续要求存在顺序风险；这是本轮静态发现，尚未复现为真实模型故障。
- **媒体通信与模型理解分开。** IM 可传图片、音频、视频和普通文件，按安全检测类型预览/播放/下载，兼容性不足可下载。当前本地 Worker 仅对创建任务的原始事件走附件入口；运行中补充附件未完整转交，`remote-tools` 未提供附件运输。不能声称群里任何媒体都会被模型理解。

## 已复现的自动交付与恢复问题

远端2026-11-10的[独立审计](outputs/AUDIT-SUPERAGENT-v0.3.1-2026-11-10.md)使用固定源码和零模型合成探针复现了以下问题。本轮合入报告并更名，没有修复执行代码；常规测试通过不覆盖这些缺口。

| 优先级 | 问题与影响 |
| --- | --- |
| P1 | 进入交付后收到的补充可能回复已加入，却未被Worker消费就完成合并，也未创建后续任务。 |
| P1 | 固定测试命令不等于可信测试来源：Worker可在验收前修改脚本/测试使其变弱，现有前后指纹无法阻止。 |
| P2 | 构建后未再次锁定HEAD，构建脚本自行提交时可能使资产来源偏离声明的merged commit。 |
| P2 | 发布失败进入needs_attention后，普通聊天继续/重启无法完成原发布账本续发，历史交付曾有人工补位。 |
| P2 | 远端取消返回后，在途文件写入仍可能落盘；停止进程不代表远端IO已排空。 |
| P2 | IM Thread不能逐跳完整召回Task，Router最近80任务之外缺续读入口；静默核查在重启时可能发出无效群通知。 |

应优先修复两项P1，再处理发布/停止/图召回；随后补输入按序、附件、全局上下文预算/摘要与异机长期验收。在这些门槛修复及独立验证前，建议由人审查代码差异和不可被Worker改写的最低断言后决定合并。云端密钥隔离还需另行实施，下节说明现状。

## 部署方式与权限原则

| 位置/模式 | 代码与工具在哪里 | 当前证据 |
| --- | --- | --- |
| 本机 installed-headless | 控制器调用同机已安装 DSH，每任务独立副本 | 已有本机原生模型验收历史。 |
| 远端原生执行接入 | 控制器对接已配置的原生执行端 | 有对应接口和测试；不以此推断所有异机环境已通过。 |
| `remote-tools` | DSH 会话在控制侧，代码读写与固定命令在独立 daemon；关闭 Worker 本地原生文件/shell工具 | 2026-11-09实证为同机不同目录/独立进程，控制侧目录为空；不是物理异机或腾讯常驻验收。 |
| 腾讯轻量服务器上的 IM | Linux Docker Compose、Caddy TLS、单 FastAPI、SQLite/WAL 和附件卷 | 有[部署资料](workspace/deploy/README.md)及历史容器验证；本轮未部署腾讯。 |

配置决定监听群、派任务成员、仓库、执行目录、固定测试、预算和交付策略；聊天与附件属于不可信输入，不拼进 shell 命令。助手只能读取被加入的聊天，群授权和成员授权同时检查；未知来源与机器人事件过滤。

**工作副本隔离的是代码变更，不是操作系统权限。** 本机 DSH 示例可以使用广权限工具，不能保证提示注入无法触及其他本机资料。高隔离需求应另行设计受限账号/容器/主机及凭据范围。密钥、账号、聊天、附件、数据库、原生会话和用户目录不提交 Git，真实配置保存在忽略目录。自动化控制凭据不传给编码 Worker。

云端API key保护的建议结构、凭据分工和验收范围见[云端DSH安全设计](workspace/docs/CLOUD-SECURITY.md)（2026-11-17，未实施）。真实模型key由独立调用代理持有，编码环境不取得它；当前环境变量剥离只是有限删除名单，未默认去除所有GitHub/自定义密钥，现有任务token也没有自动时效/费用限制。不能把本机工作副本或IM的Docker模板当作云端DSH安全成品。

IM 面向小团队，实时连接路由在单进程中；增加 worker/集群前必须重设计。当前不含实时音视频通话、转码、端到端加密或文件断点续传。SQLite/WAL 和备份降低运维复杂度，附件访问仍按成员关系校验。

## 本次核对的证据等级

历史模块、原生模型夹具、实际PR/Release分别有证据，仍未证明“普通讨论→在线Router→真实DSH业务改码→不可被Worker改写的最低验收→合并→发布→群回传”整条链。现有P1更说明不能由各段通过推定整体可信。

| 证据 | 能证明什么 | 不能据此声称什么 |
| --- | --- | --- |
| 2026-11-10 当前源码审查 | 控制器/并发/引用/监督/交付机制确有实现，以及上述静态边界 | 所有任务均能正确完成，或已长期生产运行。 |
| 本轮常规、浏览器与打包验证 | 结果见[v0.3.2验收报告](outputs/VERIFICATION-v0.3.2.md)；过程/传输测试包含模拟 DSH/gh | 模拟测试等同真实模型编码、评审或腾讯部署。 |
| 2026-11-09 真实原生模型历史 | 三个 Worker 会话、四次 invocation，含并行小夹具、原会话 steer 消费和独立工具 daemon；只读 Router 两会话、Watchdog 一会话 | 任意规模代码质量、全部媒体理解、物理异机或长期高负载。详见[v0.3.0报告](outputs/VERIFICATION-v0.3.0.md)，其中失败与修正记录保留。 |
| 本机当前运行 | 按最新[state](environment/state.json)与[HANDOFF](workspace/docs/HANDOFF.md)及实际进程查询确认 | 不能把另一检出的“已在线”或旧轮次的“模型调用为0”当作当前事实；QA新配方是否真实验收完成须另看本轮记录。 |

## 开发、恢复与源码入口

先读根 [AGENTS](AGENTS.md)、[RESTORE](RESTORE.md)、state、HANDOFF 和最新过程；干净工作树才 `git pull --ff-only`。新机器不会随 clone 获得旧机器的账号、运行数据库、DSH认证或Windows成品。按[恢复与运行说明](workspace/README.md)执行 setup、首次建管理员、助手绑定和启动，不在 README 写入真实密码或连接码。

桥接需要 Node **>=24.9**，桌面工具需要 Node >=22.12；本次使用项目内隔离 Node24.19.0，未改全局 PATH。常规验证不调用模型；真实QA分析按明确授权范围执行，用量只统计。历史编码实验规则见各自设计与验收。UI 保持远端已选石墨主题、图标优先与精简文案，用户界面不展示这里的架构说明。

```text
workspace/
  client/             登录、聊天、媒体、成员与设置
  desktop/            Windows Electron 入口和白名单打包
  server/             单进程 IM、访问控制、SQLite 与附件
  bridge/             DSH 接入、Router/Worker、监督与交付
  docs/               设计、决策、过程、验收与交接
  deploy/             腾讯 Linux/Docker/Caddy 部署资料
references/           官方来源、目录约定与技能来源
outputs/              可共享报告；Windows 大包走 GitHub Release
environment/          恢复脚本/示例/状态；真实配置和数据忽略
```

| 要读的代码/设计 | 入口 |
| --- | --- |
| 总体设计、接口、决策与本轮范围 | [DESIGN](workspace/docs/DESIGN.md)、[API](workspace/docs/API.md)、[DECISIONS](workspace/docs/DECISIONS.md)、[v0.3.2范围](workspace/docs/REVIEW-TEAMPLAY-v0.3.2.md) |
| 事件接收、任务状态机、分类 | [super-agent.mjs](workspace/bridge/super-agent.mjs)、[super-coordinator.mjs](workspace/bridge/super-coordinator.mjs)、[super-router.mjs](workspace/bridge/super-router.mjs) |
| 原生执行、输入回执、引用召回 | [super-worker.mjs](workspace/bridge/super-worker.mjs)、[super-inbox-plugin.mjs](workspace/bridge/super-inbox-plugin.mjs)、[super-context.mjs](workspace/bridge/super-context.mjs)、[installed-headless.mjs](workspace/bridge/installed-headless.mjs) |
| 独立监督、PR与发布 | [super-watchdog.mjs](workspace/bridge/super-watchdog.mjs)、[super-github.mjs](workspace/bridge/super-github.mjs)、[super-release.mjs](workspace/bridge/super-release.mjs) |
| 管理与启用新模式 | [桥接说明](workspace/bridge/README.md)、[Super-agent操作](workspace/docs/SUPER-OPERATIONS-v0.3.0.md)、[完整规格](workspace/docs/SUPERAGENT-v0.3.0.md) |
| 持续接续与历史 | [PROCESS](workspace/docs/PROCESS.md)、[TESTING](workspace/docs/TESTING.md)、[HANDOFF](workspace/docs/HANDOFF.md)、[proj_multihandoff](.agents/skills/proj_multihandoff/SKILL.md) |

每个验证通过的迭代按明确文件清单提交、创建新 annotated tag、推送并查询远端确认，不强推或移动发布标签。更名保留 `TeamRelay.exe`、npm/配置键和旧用户目录等内部兼容标识；当前页面、窗口与Windows产品属性显示 **同频TeamPlay**，历史截图和旧版报告保持原样。
