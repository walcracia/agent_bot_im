# QA 日志流程实现 v0.4.0

日期：2026-11-20。阶段：设计冻结，开始实现。覆盖 QA-TRIGGER-ROUTE 中“本轮仅设计”的阶段说明，其安全与输入版本要求继续适用。

## 范围与授权

实现 Super-agent 内的 QA Source → 持久 Trigger → SuperRouter typed route → log-triage Worker → 统一 Outbox。保留旧 code 任务和账本；日志任务不进入 Git、代码工作副本、PR、发布。用户选择一个真实项目，允许新建结果聊天及最多一个 Bug 的真实分析；具体项目ID、聊天、凭据、缺陷及日志不入Git。先完整基线，历史缺陷不冒充新增。真实试点须区分自动新Bug与明确手动历史重分析。

用户允许以后在聊天里指定跟踪项目。仅预配管理成员在已授权聊天发送精确命令“跟踪项目 DEMO”/“停止跟踪项目 DEMO”才改变绑定。需核验成员、管理员白名单、QA项目唯一匹配和聊天内机器人身份；正文/日志/模型不能改变绑定。权限撤销暂停发送并保留报告。首期每个项目固定一个聊天，重复跟踪不同聊天拒绝。

## 冻结接口与账本

### 用户追加的执行边界（覆盖原纯报告模型方案）

用户进一步更正：“业务平台”在本系统中具体就是Super-agent的日志分析Worker，负责真实故障排查这个业务角色；IM是触发与结果展示入口。统一流程为IM/QA Trigger→Router→日志分析Worker提交白名单skillId、任务参数、输入文件→执行适配层选择本机Agent→Agent加载skill并调用模型和受控工具完成排查→适配层校验JSON结果与文件清单→Worker保存、安排授权附件下载与Outbox回传IM。Worker业务角色不等同于某个模型提供商，DSH/Pi/Hermes/OpenCode是可替换执行后端。故障时间是可选参数，不是流水线核心准入条件。

首实现后端为本机DSH，固定skillId=ota-log-triage@1.3.2。Pi/Hermes/OpenCode按同一执行请求/结果协议预留适配接口，不冒称已接通所有后端。不通过全局skill/命令任意选择可执行代码。Agent拥有仅本任务材料的日志工具：读取固定skill、列输入、读取有界证据、运行固定解析器。宿主文件/任意shell/QA凭据/Git写入不授予Agent。工具通过单独stdio服务供DSH使用，执行适配层验证skill实际读取、实际工具调用、报告证据与产物；不是仅把skill文字拼入一次无工具模型调用。

真实Agent在6次生成/11次工具后因阅读上限终止，已成功加载skill、解析并读取证据，但未形成模型终稿。为满足用户“至少给初排”，增加有条件partial结果：仅在确定的预算停止、原生进程终止、真实skill/parser/证据收据完整时，零追加模型调用地将已读且可独立核验的异常行整理为程序初排，置信度低、责任方待验证，明确“助手未完成完整判断、只提供已核对线索”。外层status=partial、任务partial，不冒称completed模型诊断。凭据/协议/输入校验/未知终态错误仍拒绝，不能用partial绕过证明。操作者可对当前已终止的同一次分析收集partial，保留原attempt/revision、预算和失败；不得触发新Agent或新增费用。

用户指出原DSH插件没有阅读上限，复核原因是本适配器人为6轮/12工具/64k累计读入及小批证据/一次parser限制，与原插件先整理证据后生成报告不同。交付前改为可信可配置 executionLimits，默认12轮生成、32工具、192k单请求输入、128k工具累计返回、96k证据返回、最多4次不同有界parser范围；硬上限仍有界（32/96/384k/384k/256k/8）。read_evidence一次可取本任务最多60条，重复已送证据仅返回已有索引提示；相同解析范围缓存，不重跑进程，不用固定“一次parser”错误驱动Agent无效循环。每个parser仍最多3文件/16MB、文件/解包/权限/路径/截止时间门禁不放宽。工具返回剩余预算，提示优先交结果。已有真实6轮收据按旧策略保留/partial，不追加本轮模型；新默认只经隔离测试，不冒称真实终稿已通过。

首次试点把一次分析定义为一个Bug的一个有界Agent执行会话，旧试点上限6次provider请求、每次2400输出token；当前交付默认值以下文用户追问后的executionLimits覆盖；仍有受限工具数量/读入字符及10分钟执行上限；总分析额度仍为1、日额度1。账本保留分析次数和provider请求次数的区别。报告产物首先保存私有结果文件，平台仅按现有认证附件机制提供下载，不能发匿名宿主目录。取消/重启未知副作用不自动重做。

- QaMcpClient({command,args,cwd,env,timeoutMs,maxResponseBytes})：start/callTool/close。标准 newline JSON-RPC stdio，无 shell；不透传stderr。
- QaAdapter({client})：listProjects、listIssues({projectId,pageIndex,pageSize})、getIssue({projectId,issueId,no})、listFiles(issue)、getFile(fileId)。无issue_get；精确issues_list匹配。缺失description/故障时间不抓私有Desktop路由。
- QaSource({binding,adapter,limits,now}).poll(checkpoint) → {triggers,checkpoint}。固定绑定sourceId/projectId/conversationId，完整有界分页及附件列表快照。基线不触发历史；重复ID/count变化/断页失败不推进检查点。sourceRevision为规范快照SHA256，不含URL/观测时间。closed新记录不触发分析；已订阅关闭事件仍持久。
- Trigger字段：triggerId/sourceKind/sourceId/eventKind/projectId/externalIssueId/externalIssueNo/conversationId/observedAt/sourceRevision/issue。QA独立服务主体，不伪造人类IM event。
- SuperRouter.routeTriggers(triggers,{tasks,context})，确定通道验证可信来源及任务类型；返回triggerId/taskKind=log-triage/action/taskId。明确编号和订阅无需模型分类，不以QA内容申请code。
- SuperTriage({coordinator,adapter,sourceFactory,worker,options})，使用协调器transaction、state.superAgent、nextTask、inbox、graph、subscriptions、outbox和active。方法initialize(data)、captureIm(data,event,reference,thread)、pollSources()、routePending()、authorized(task,conversations)、eligible(task)、execute(id)、cancel(id)、beforeSend(item,conversations)、close()。typed日志任务无task.event人类身份要求。
- LogTriageWorker({adapter,root,skillRoot,model,limits,now,python}).run(snapshot,{signal}) → {status,text,report,manifest,inputRevision}。允许waiting_input/waiting_log/completed；收费执行中断保守paused/uncertain，不自动再跑。
- inputRevision在同事务内递增。一次attempt冻结snapshot，运行/验证/建Outbox/发送均核对。旧结果已发送时也保留后续queued attempt；每条补充可追溯，不仅确认收到。
- 同一缺陷按source/project/issue及当前聊天关联；QA与IM Thread双向订阅，共用T编号。跨群、未授权、机器人消息拒绝。
- 已持久报告与固定正文/摘要/hash/revision/幂等键一同入Outbox。失ACK只重发相同内容，409暂停核查。完整详情按同群权限分片读取。

## 执行与限制

真实单Bug试点的压缩包约17MB、展开约238MB，初版128MB展开预算在模型前拦截。按实际正常日志体积，将可信解包/执行适配/MCP输入总上限统一调整为320,000,000字节（每文件仍64MB、数量800、压缩比150）；不改变IM附件<100MB要求、模型输入/扫描行/工具次数/会话额度。原失败保留且模型调用0。日志扫描/模型只接触有界证据，报告必须说明未覆盖全量材料。

固定上游parser对238MB全量目录在512MB堆上限内退出134（本机诊断，模型0）；不靠无限增加内存运行。生产skill服务分支由Agent自主调用run_parser选择至多3个白名单文件、总计16MB（省略时按已提取证据的文件确定有界默认）；可信服务复制到独立解析目录并维持原相对名，固定解析命令/60秒/512MB/2MB输出不变。Worker只准备有界证据与输入，不在Agent之前重复全目录解析。超大单文件可仅作逐行证据初排；解析范围/省略数量必须回传。未被选择材料不宣称已分析。此修正在真实Agent会话前完成，不能把OOM诊断当收费分析。

真实压缩包到Agent的接缝再发现“已展开archive副本仍留日志根，但只列leaf清单”，严格MCP在模型前拒绝。解包成功后仅清理本次自身生成且身份验证相同的中间archive，不清失败目录、不删原download、不放宽白名单。首次原生启动失败保留；确认无provider证明、native session为空/eventCount0、launcher退出、无任务工具进程后，由操作者离线保留reservation并标void_before_provider，恢复唯一试点额度。未知/已收费调用不得套用这个人工纠正，不自动重试。

固定公开skill1.3.2 SHA256见QA-TRIAGE-SOURCES；安装到忽略tools，不修改DSH。可信解析入口和逐文件manifest在运行前验证。下载白名单origin、禁止跨站重定向、每文件/总字节/时间/文件数上限。安全解zip/tar/gzip拒绝路径逃逸、链接/特殊文件、嵌套/膨胀超额。固定argv不拼shell。日志Worker不获得GitHub写配置。

用户随后明确覆盖旧设计：真实业务常缺少故障时间，必须兼容并输出初排结果。有可识别日志即允许preliminary模式：不造故障日期/窗口/时区，不以openedAt代替；只在预算内找异常线索、保留原始时间与时钟域未确认标记，不宣称已对齐跨设备时间或确定因果。没有完整描述时使用标题作为有限症状，并明确缺口。无日志仍等待日志；无异常或无可识别日志不得编造根因，可输出“尚无明确异常”的初排及下一步。显式时间范围完备时使用精确窗口模式；格式错误的显式范围请求补充。明确群命令补充“分析 DEMO-42 日期 YYYY-MM-DD 时间 HH:mm-HH:mm 时区 UTC+08:00”或“#T000001 日期 ...”。解析证据、症状、上下文、提示词合计有字符预算；模型只给证据报告，无工具能力。纯模型后端使用独立DSH只读调用并禁用工具；这不是OS沙箱，未实现云密钥代理。

默认轮询60秒、并发1、单次15分钟、每轮扫描2000缺陷/20页/有限附件及请求；具体预算由配置校验。模型运行额度在调用前持久扣减，日限/总限均有效；真实试点总限1，自动扫描不会扩大预算。首次缺资料0模型；迟到日志回原任务新版本；关闭停止未启动自动分析，明确手动可重分析。

## 验收

1. 合成QA分页/基线/变化/错误不推进，stdio真实子进程契约与响应大小/超时。
2. QA与IM都经typed Router、统一任务/订阅；假code指令不进Git；管理员绑定与跨群拒绝。
3. 无日志0模型；缺时间/时区/详细描述仍能给有限初排，显式说明未对齐/不作确定因果且不猜时间；完整窗口严格筛选；附件到达同任务；多阶段补充revision不遗漏；重复Trigger去重。
4. 下载/压缩包/恶意路径/预算/技能哈希；固定真实parser合成日志及UTC/本地时间边界。
5. 持久报告→真实隔离IM API，ACK丢失/重启重发每片一次且不再模型；撤权/409暂停。
6. 启动恢复running收费任务不自动重做；源故障与代码/IM循环隔离；取消等待终态。
7. 常规verify回归；区分假模型、真实MCP/解析、真实DSH调用。真实最多1个Bug，材料不够如实记录待补充，禁止假通过。
8. README业务/部署/限制更新，HANDOFF/state/PROCESS/TESTING与脱敏报告同步；新annotated tag + push并查询远端确认。
