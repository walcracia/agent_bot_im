# v0.4.0 QA 日志排查配置与执行协议

## 当前覆盖：v0.4.2

先读QA-MONITORING-v0.4.2。下文v0.4.0/v0.4.1的累计/日额度、模型/工具/字符/解析/报告依据条数、人工总超时等门禁全部为历史；当前只统计用量，不补额度、不换大数。一个Bug的一次Agent会话使用原skill，按页继续读日志、分批解析并取得新的真实证据，完成后正常发送报告/附件及用量小报表。只自动接续确定未开始模型的旧额度阻塞任务，其余未知执行/取消保留。工具权限、文件/hash/行核验、当前用户认证及IM每附件<100MB原约定继续。

## v0.4.1 更新

当前标准见QA-ACCEPTANCE-v0.4.1。modelSelection可增加可信reasoningEffort（例如本机模型实际支持的off），只影响任务自己的Agent。原插件选择模型支持的第一档，而headless默认可能是high；须核对安装实际支持的档位，不能只对齐模型名称。流式扫描/证据核验为2M行/320M字符，模型仍最多60条/48k字符。预处理最多4批、每批3文件/16MB，Agent仍独立加载skill/使用工具。直接回传skill生成的结论、可信度及责任倾向，不自动降级或追加程序诊断。下文v0.4.0真实partial记录保留为历史。

默认编号分析相当于原插件的现象输入留空：QA标题/描述保存在来源账本，不自动作为skill现象。聊天明确补充“问题说明”才作为symptom参数传入；日期/窗口仍按显式参数。这样调用方不会额外要求skill证明QA流程文字或限定其判断。

日志分析 Worker 是业务调用方。生产 runtime 使用 SkillExecutionService → DshSkillRunner → 固定 skill/四个日志工具，不是无工具的一次模型摘要。Pi/Hermes/OpenCode只有同协议注册扩展点，当前默认仅DSH。

1. 先运行 `environment/scripts/install-triage-skill.py`，安装固定1.3.2及24文件完整性清单到忽略tools；原DSH不变。
2. 在忽略的bridge配置中复制 `config.super.example.json` 的 `superAgent.triage`，显式启用、选固定sourceId、项目ID/代号/聊天与adminSenderIds；聊天/成员须同时存在于原conversationIds/senderIds白名单，机器人须已在群中。首轮建立全量历史基线，不补跑历史。
3. `mcp.command/args/cwd`指向操作者的可信QA MCP安装。认证只从列出的QA_环境变量或本机envFile读；envFile为QA_键到字符串的JSON，禁止把值粘到示例/Git。可使用操作者已登录的只读SSO缓存，适配层只暴露读取工具。
4. allowedDownloadOrigins只列实际QA附件的精确origin，无通配符；不跟跨站重定向。root/skillRoot/python为可信路径。分析总/日额度默认0，启用真实执行前明确设置；总额度累计不会随重启清空。每次分析默认12轮生成、32次工具、总10分钟；可通过executionLimits调整，硬上限32轮/96工具。
5. 以 `environment/scripts/start.ps1 -DshConfigPath <忽略配置>`启动现有Super-agent生命周期。仅QA可设superAgent.codeEnabled=false和watchdog.enabled=false；不会把普通聊天转成代码任务或额外监督模型调用。默认共存模式保留code功能，日志任务仍走独立类型。
6. 在批准群贴 `DEMO-42` / `分析 DEMO-42` / `重新分析 DEMO-42`。管理员可发 `跟踪项目 DEMO` / `停止跟踪项目 DEMO`。完整时间可选追加 `日期 2026-11-20 时间 10:00-10:20 时区 Asia/Shanghai`；日志时钟域可显式补 `日志时区 ota=UTC slave=Asia/Shanghai`。缺失时做有限初排，不猜故障时刻。

DSH的headless默认模型可能与Desktop选定模型不同。triage可显式填 `modelSelection: {"provider":"所选provider标识","model":"所选model标识"}`（这里只是字段示意；值须是安装实际支持的标识），适配器只覆盖模型选择并复用DSH当前用户已保存认证，不复制API key。默认模型缺凭据时保留失败，不自动改用其他付费模型或重跑；先在本机确认凭据/选定模型与原生执行终态，再由操作者处理。分析总/日额度按持久账本计，日使用UTC日期，不随重启清零。

大日志包安全展开总上限320MB、每文件64MB；扫描最多200,000行/16M字符、候选1200、模型证据60及总48k字符。Agent的run_parser选择至多3文件/16MB，范围与省略数量随工具结果记录，不能宣称覆盖全部输入。最初128MB容量与上游全目录parser OOM拦截的修正见实现规格和过程记录。

统一执行请求含taskId/inputRevision/skillId/parameters/inputFiles及仅本地可读executionContext。执行结果含schemaVersion/status/result(JSON)/files(报告名、类型、大小、SHA256、私有路径)/execution(实际Agent会话、provider、工具数、skill加载与校验证明)。私有路径只供执行/上传器，图引用与聊天不输出。输入前后校验、证据行核验及产物只由受信服务生成，Agent不能提供任意输出路径。

报告文本与JSON作为小附件经原IM认证接口发布，成员按现有临时票据下载；不公开匿名原始日志地址。丢消息ACK复用固定client_id与已保存attachmentId，不再分析。丢上传ACK可能留下最多3份无人引用的小报告，上传重试达限暂停，不无限生成文件。原始日志不上传IM。

默认扫描每60秒，完整有界分页/附件ID快照；首次基线0分析。没有可靠后端事件游标，同附件ID的原地替换无法仅靠来源ID发现；新ID可发现，手动重分析会重新下载并算SHA。源断网保留检查点并退避；不确定模型执行重启后暂停，不能换会话自动重试。云OS隔离和独立密钥代理未实现。
