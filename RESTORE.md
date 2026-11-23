# agent-IM 恢复与接续

## v0.5.3 最新模型覆盖

先读MODEL-QWEN-v0.5.3和最新HANDOFF/state。DSH、Pi、Hermes及同频Router/QA统一Qwen4 Max、High，覆盖下方旧DeepSeek/max与off；文字High优先截图XHigh。核原生配置及实际请求，不仅看界面标签。模型目录在可信用户配置登记；DSH的desktop和headless配置需分别存在同一Qwen provider引用，保留已有认证。Pi和Hermes新建/恢复明确选择并核对model/High。真实会话、配置备份与账号不入Git；旧已完成任务不重做。

## v0.5.2 中文交互

协调者与DSH/Pi/Hermes及开发子Agent的任务说明、补充、进度和结果说明一律简体中文，具体见AGENTS及AGENT-LANGUAGE-v0.5.2。机器字段/枚举、命令、源码、原始材料及固定skill提示/报告保留原格式；不用额外模型改写历史或skill结论。

## v0.5.1 最新覆盖

先读DELIVERY-v0.5.1及最新HANDOFF/state。2026-11-23用户恢复日志测试，覆盖下方“等VPN不恢复”；启动前仍实查授权读取，不能凭匿名附件可下载判断登录。DSH业务/Router/QA/显式回归统一max，覆盖下方旧首档/off；原插件材料和提示不改，原生模型输出容量记录在receipt，不设新分析额度。

每轮验证完成都执行`environment/scripts/deliver-windows.ps1`生成当前版本便携目录/ZIP/SHA并实际启动验收，源码tag及对应Release均需远端确认。客户端包不包含服务器或DSH/Pi/Hermes。Pi/Hermes原生记录的登记/命名及桌面筛选见本轮设计；不能复制或伪造会话历史。

## v0.5.0 通用业务入口

先读WORKER-ROUTING-v0.5.0、最新HANDOFF和state。superAgent.business启用只读AI按可信登记能力选择Worker/DSH/Hermes/Pi；B任务与旧代码/QA的T任务分开，独立目录和原生会话，Outbox回单条原结果+TXT。本机已配置三执行器与“智能协作验收”授权聊天，命令、账号、数据目录和技能只在忽略配置；新机器参考config.business.example.json按实际安装/认证设置，不能clone即假定可用。

运行中补充持久保存后沿原会话下一轮；未知原生终态先核对，禁止新建会话冒充接续。三执行器取消方式不同，尤其Hermes关闭ACP客户端不表示gateway内Agent已停止。Pi原生MCP默认direct；Hermes外部未登记skill路径需管理员映射，不静默丢掉技能。QA仍disabled等用户接入VPN，不在恢复通用业务时打开。

实际验收包括三自然语言请求→AI选不同Worker/Agent→真实完成→单条报告下载；三原生Agent回归及发现、修正、失败/最终计数以最新记录为准，不能用模拟协议或工具ACK替代。

## v0.4.2 无额度、会话观测

先读QA-MONITORING-v0.4.2及最新HANDOFF/state，覆盖下方所有QA试点/会话额度与扫描阅读限制。用户已明确撤销这些人工停止条件，后续不要再因累计次数、模型/工具/读取/解析次数、总字符或人为总时长暂停分析，也不能换大数冒充取消。聊天只发原结论和一个完整TXT附件，用量在下载文件里；不另外刷用量消息。

最新用户要求完全复用原DSH插件分析配方。生产默认chery-qa-plugin：整包CLI、相同上下文/关键行/提示词和直接prepareCall；旧四工具Agent只作历史兼容。新配方整包解析和提示逐字比较已通过，真实模型尚未验收：2026-11-21本机公司QA内网连接超时，用户明确暂停日志分析等VPN；本机启动配置triage.enabled=false，不自行重开。恢复应重验授权QA读取，再按原未完成重分析请求/输入版本执行，不冒称已经完成新配方真实全程。

用户新增目标是通用AI分流、DSH/Hermes/Pi三执行器和三Agent实际回归；这是继续进行的主目标，QA暂停不等于整个目标暂停。先读WORKER-ROUTING-v0.5.0和最新HANDOFF。CLI/desktop均在本机已装，具体路径和认证不随Git复制；能力以实际协议和真实测试为准。

日志按页/批处理，后续真实行可加入证据集合；原权限、凭据隔离、文件/hash/行校验及IM每附件<100MB业务约定继续。仅旧额度导致且确认模型未开始的暂停任务升级自动排队，其余终态/取消/未知进程仍核对，不重复实际模型。当前本机账号按用户指定更新，秘密仅在忽略凭据/数据库。源码改后台不要求重建兼容v0.3.3客户端。

## v0.4.1 skill直接输出与正向验收

先读QA-ACCEPTANCE-v0.4.1及最新HANDOFF/state。用户要求真实正向完成并直接回传skill结论，不能以partial/paused作为完成；缺关键输入直接询问。默认不把整段QA描述自动当作skill现象，显式聊天“问题说明”才映射symptom。结论/可信度/责任方不因缺时间被程序改写，显示不追加宿主诊断句。

正常大附件先有界分批解析，再流式回读/平衡取证；2M行/320M字符，Agent上下文仍最多60条。DSH模型还需对齐reasoningEffort：原插件用模型支持的首档，本机为off，headless默认high曾耗尽4096输出且无终稿。配置仅影响任务自己的Agent，不改DSH安装或全局设置。QA缓存可能过期；以实际授权接口读成功为准，匿名文件可下载不代表登录有效，过期应请求完成标准登录，不伪造缓存时效。账号/日志/登录记录只在忽略目录。

## v0.4.0 QA日志业务Worker

先读QA-IMPLEMENTATION-v0.4.0、QA-OPERATIONS-v0.4.0、最新HANDOFF/state与验收报告。用户最终澄清：业务平台具体是Super-agent日志分析Worker；它提交skill ID/参数/文件给执行适配服务，由本机Agent加载skill和工具排查，再交Worker/Outbox回聊天。当前首适配器DSH，其他后端只有注册协议。故障时间可选，缺失仍初排，不猜时区/确定因果。

真实绑定/账号/日志/SSO缓存/DPAPI/运行账本不在Git，克隆后不能假定监听在线。固定skill使用environment/scripts/install-triage-skill.py安装1.3.2及24文件hash；不要把原Desktop手动插件私有路由当后台API。原代码A1/A2仍未修。本轮Windows界面/托盘不变，v0.3.3客户端兼容v0.4.0服务/桥接，未因改源码就声称新EXE已构建。

## v0.3.3 托盘与QA日志设计

Windows客户端最小化留任务栏、关闭收托盘，继续收消息；点击图标恢复，右键“退出”退出客户端。后台不自动标读，前台只读当前会话；保留旧用户目录/TeamRelay路径。规范DESKTOP-TRAY-v0.3.3，当前包outputs/desktop-v0.3.3/TeamRelay-win32-x64/TeamRelay.exe，或下载v0.3.3 Release；从Git恢复需重建而非假定EXE存在。

用户明确要求QA新增Bug按Super-agent Trigger+Route进入专用只读日志任务，群贴编号可重分析。流程与本地插件实际接缝见workspace/docs/QA-TRIGGER-ROUTE.md和references/QA-TRIAGE-SOURCES.md；目前只设计，不能称自动分析已启用。没有修改DSH安装、读取业务日志或调用真实模型。新增浏览器与原生验证使用临时IM、合成账号和隔离profile，过程/失败/实际交付以VERIFICATION-v0.3.3及最新HANDOFF/state为准。

## 2026-11-17 本检出接续

当前D:/Work/CodexProjects/agent-bot-im已同步到5c5e676（产品v0.3.2）；本机Python3.12.15/Node24.19.0常规26/256/16及语法通过。正式IM/DSH/监督未启动，0.3.2 EXE未在本机取得/构建，认证和SDK握手未验证。报告见`outputs/VERIFICATION-handoff-2026-11-17.md`，实际状态见state.current_checkout及HANDOFF最新条目。下方其他检出及旧版本在线/构建记录均属历史，不代表本机当前状态。

## v0.3.2 同频TeamPlay

当前源码及Windows产品名已改为“同频TeamPlay”，执行机制沿用v0.3.0。根README包含文章核对结论、团队协作/业务流程、实际能力边界与源码索引；本轮范围见 `workspace/docs/REVIEW-TEAMPLAY-v0.3.2.md`。更名保留TeamRelay.exe/配置键/旧用户目录，旧报告和截图不覆盖。新包路径为 `outputs/desktop-v0.3.2/TeamRelay-win32-x64/TeamRelay.exe`，源码Git不含大包，下载对应Release或重建。

下方“本机已启用”是历史检出的记录。本轮正式IM/DSH/Watchdog未启动、模型调用0；临时浏览器验收服务会自动清理。当前检出验证/交付结果先读最新HANDOFF/state及 `outputs/VERIFICATION-v0.3.2.md`，不要从旧在线快照推断正在运行。

## 2026-11-10 审计更正

接续先读`outputs/AUDIT-SUPERAGENT-v0.3.1-2026-11-10.md`及HANDOFF最新条目。v0.3.1具备核心Super-agent框架，但仍有交付期输入遗漏、可信测试来源、发布恢复等已复现缺口，不可再宣称全部符合原文。当前桌面为Electron；EXE不启动后台，只有start.ps1统一确认IM/已绑定DSH/独立监督。Tauri尚未迁移。本轮仅审计记录与合成探针，现有产品/Release/配置不变。

## v0.3.1 历史入口（执行机制沿用）

用户要求的Super-agent范围见`workspace/docs/SUPERAGENT-v0.3.0.md`及各SUPER模块设计，操作见`SUPER-OPERATIONS-v0.3.0.md`。本机选择不部署腾讯。默认start仍从已绑定本机配置同时确认IM与监听；新模式另确认独立Watchdog。首次机器先按下方setup恢复、ServerOnly建账号、connect-installed绑定，再以enable-super转换；私有账号、DPAPI密文、任务/模型会话和本机工具不会随Git clone出现。

新模式每任务独立worktree/session，支持最多配置数量的并行、运行中补充/停止、原生消费回执、跨PR反馈、上下文引用续读、独立监督和已确认合并后的构建发布。静默主动核查须同时配置proactive及可信交付验证。迁移保留旧账本并继承确定游标；旧未完成任务先处理，不清锁换会话。实际本机运行与远端状态按HANDOFF最新条目、state及实查确认；下方v0.2历史说明不覆盖v0.3。

项目根为本文件所在的 Git 仓库目录，以 `git rev-parse --show-toplevel` 确认，不依赖旧电脑盘符。历史记录中的 `D:\Work\CodexProjects\agent-bot-im` 只是当时检出位置；本次应使用当前检出，不另建嵌套目录。

1. 阅读根 `AGENTS.md`、`environment/state.json`、`workspace/docs/HANDOFF.md`。
2. 阅读 `workspace/docs/DESIGN.md`、`API.md`、`DECISIONS.md` 与 `PROCESS.md` 最新记录。
3. 查看 Git 状态、origin、当前分支/upstream 和 tags。干净工作树执行 `git pull --ff-only`；本地修改、分叉或 detached HEAD 先保留并处理，不自动 stash/reset。首次克隆地址为 `https://github.com/walcracia/agent_bot_im.git`。
4. 按 `environment/README.md` 恢复本机环境。数据库和密钥在忽略目录，不进 Git。
5. 执行 `environment/scripts/verify.ps1` 后再判断当前可用程度，正式报告写入 `environment/verification/`，可发布报告复制至 `outputs/`。

遵循同级项目的 workspace/references/outputs/environment 布局。安装、启动和验收应通过脚本完成，不能依赖聊天上下文。

完整布局约定已纳入 [references/PROJECT-LAYOUT.md](references/PROJECT-LAYOUT.md)。父目录旧布局文件缺失时，以仓库内版本为准，保留本项目现有结构。

## 干净检出的最短恢复路径

准备 PowerShell、Git、uv、Node.js（桌面工具要求 >=22.12，普通 DSH 路线要求 >=24.9），在项目根运行：

```powershell
.\environment\scripts\setup.ps1
.\environment\scripts\verify.ps1
```

uv 未加入 PATH 时用 `setup.ps1 -UvCommand 'uv.exe的实际路径'`；仅恢复服务与常规测试可加 `-SkipDesktop`。首次使用 managed Python 3.12，解释器下载到忽略目录 `environment/tools/python`。不借用办公软件内置解释器。

常规验收不需要演示账号或模型密钥。首次启动/建管理员见 `workspace/README.md`；真实模型与腾讯部署另有前提。Git 不含账号/聊天/附件/venv/DSH/桌面二进制；Windows 成品从对应版本 Release 获取或按锁文件构建。历史通过项不能当作本机复验通过。

当前源码UI为v0.1.4石墨主题，规格见workspace/docs/UI-v0.1.4.md；布局减负依据仍是UI-v0.1.2。真实浏览器回归用environment/scripts/verify-ui-v0.1.2.py，当前主题/对比度用verify-ui-graphite.py；均用隔离数据/服务。旧verify-ui-theme.py只适用于v0.1.3蓝色历史快照，不作为当前验收入口。绿色/四风格初审截图保留为历史；当前C预览中的设置图标已更新。

通用接续流程及独立安装方法见 [.agents/skills/proj_multihandoff/SKILL.md](.agents/skills/proj_multihandoff/SKILL.md)。

历史v0.2交付记录（不代表当前运行）：服务/桥接当时为v0.2.2，桌面客户端v0.2.3已构建并包含v0.1.3蓝色主题；完整目录/ZIP见outputs或v0.2.3 Release，交付验证见`outputs/VERIFICATION-desktop-v0.2.3.md`。接续自动编码先读 `workspace/docs/DSH-AUTO-v0.2.0.md`、`workspace/docs/STARTUP-v0.2.1.md`、`workspace/docs/DSH-RECOVERY-v0.2.2.md`、`workspace/bridge/README.md` 与本轮验收报告。默认 `environment/scripts/start.ps1` 同时启动或复用IM和已绑定DSH；首次绑定前用 `-ServerOnly`。绑定时 `connect-installed.ps1 -EnableStartup` 保存当前Windows用户加密的IM助手码，后续无需重复输入。真实团队的连接码/群绑定不在Git中，也不能跨Windows用户搬运密文；不要从测试日志推断监听已启动，不自动重做uncertain或routing_failed事件。2小时代码任务中断后监听保持在线，在原群明确发送“继续修正”接续原会话，发送“取消任务”结束等待；旧状态/改动/会话映射保留。

历史v0.3.0曾发布并在当时检出启用，下载/验收见HANDOFF和outputs/VERIFICATION-v0.3.0.md。自动合并策略按用户选择为verified-tests；新机器须配置自己的可信工具与绑定，不能仅clone后推断已在线。

历史风格审核入口：outputs/design-review-2026-11-10/index.html。使用environment/scripts/preview-designs.ps1重开独立静态预览（默认18310），不启动正式IM/DSH；规格与报告见UI-REVIEW-2026-11-10和outputs/VERIFICATION-design-review-2026-11-10.md。用户随后已选择C并完成落地，不再等待选择。
历史产品v0.3.1/UI-v0.1.4落实用户选定C石墨与规则设置齿轮，覆盖旧蓝色描述；v0.3.2沿用。旧Windows包见outputs/TeamRelay-v0.3.1-portable.zip或v0.3.1 Release；默认start仍同时确认IM/已绑定DSH，接续须实查运行状态。
