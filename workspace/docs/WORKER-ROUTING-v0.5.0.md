# 通用业务路由与多执行器：增量设计

2026-11-21。用户已明确要求实现通用AI分流，接通本机DSH、Hermes、Pi并让三者参与回归。本文记录设计与可观察验收，未执行项不能写作通过。日志插件对齐按QA-MONITORING-v0.4.2保留，真实QA部分由用户暂停等待VPN。

## 角色与选择边界

同频是统一业务入口，保存消息、业务事件、任务关系和结果。Trigger接入授权聊天/业务系统事件；Router读取已注册的能力说明，识别任务类型、选择业务Worker与满足需求的执行器，并关联后续消息。Worker整理业务输入、调用执行适配层，再收集业务结果和文件回到原聊天。

Agent是执行器；Skill是可加载的流程与规则；MCP是业务数据/工具接口。它们不作为同层业务任务队列。一个Worker可以使用不同Agent，也可按需组合多个执行步骤；不强制每次多Agent或让普通聊天调用模型。日志分析必须复用原DSH插件完整流程，不能再因通用Router更换分析提示或材料选取。

能力登记由本机可信配置提供：workerId、用途、输入/输出契约、可用Agent、所需Skill/MCP、允许的群/成员与操作范围。模型只在已注册且当前可用的候选中选择，不能凭聊天任意拼接命令、安装插件、扩大权限或索取密钥。技能/系统端点/凭据映射由执行端配置，不随聊天全文传递。

## 增量验收

1. 保留并验收原插件日志主流程（v0.4.2）：同附件整包解析与原提示一致，真实DSH生成原报告，聊天结论和下载可用。QA内网不可达时立即询问；离线重放与真实QA拉取分开记录。
2. 通用Router及注册式Worker MVP：授权自然语言请求经实际只读分类，选择一个已注册Worker/执行器，执行一次可验证业务任务并回聊天；对无匹配能力直接说明所缺能力，不假装执行。普通任务/补充/取消沿原task处理。
3. 本机三执行器逐个接通：发现真实安装/版本/认证就绪与协议，用同一执行请求和产物契约完成各自真实主流程；不拿模拟测试冒充Agent实际执行。能力画像以CLI/协议/已跑回归为依据，不凭品牌宣称谁更聪明。
4. 三Agent交叉回归：分别在隔离副本/材料中测试已完成MVP，产出命令、观察、失败和可追溯结果；协调者汇总并修复，再运行相关回归。每轮明确新增范围和通过的正向路径，完成后commit、annotated tag、push并查询确认。

## 当前实查与待定

三执行器原生接口及各自基础真实文件任务已通过；DSH原生Skill+MCP及Hermes已登记Skill加载另有真实证据。授权IM中三独立请求已由真实AI分别选择数据核对/Pi、文档待办/Hermes、代码检查/DSH，单条结果和认证TXT下载均通过。三原生Agent交叉回归正在执行，发现与修正单列，不能用冒烟代替回归。外部内网/模型认证/业务材料不足时优先询问用户，同时继续不依赖它们的设计、隔离实现和验证。实施过程、各执行器能力与每次真实测试另记PROCESS/HANDOFF/state，避免把计划当作完成记录。

## 执行与恢复契约

`superAgent.business`使用[配置示例](../bridge/config.business.example.json)，管理员先填实际CLI/数据目录、原模型认证和技能映射，再启用enabled；群和成员仍由原IM绑定白名单控制。新机器不会因为clone而取得原账号、Skill或CLI。普通界面不显示这些配置细节。

业务请求由只读BusinessRouter按WorkerRegistry能力选择。B任务、输入版本、已消费输入、原生session、每次结果与Outbox写共享事务账本；业务并发不进入旧代码交付队列。运行中补充持久保存，当前轮结束后沿原会话处理；旧输入版本只存档不发布成最新。恢复时未知原生终态先暂停核对，不新建Agent冒充接续。

执行接口统一为`run({taskId,cwd,prompt,sessionId?,skillPaths?,mcpServers?},{signal})`，返回backend/sessionId/text/completed/usage。完成须原生终态：DSH completed+exit0、Pi agent_settled/最后stop/idle+exit0、Hermes prompt end_turn。ACK、关闭客户端或model轮数都不单独算完成。未知用量不编数；modelTurns不冒称精确HTTP次数。

资源映射来自`workerResources[workerId].agents[agentId]`。DSH用任务overlay的customSkillDirs/stdio MCP；Pi显式Skill与任务专用MCP，默认exposure=direct，当前不支持的codemode/deferred明确拒绝；Hermes Skill只接受原home已登记路径，机械映射原生ID并零模型bootstrap，再ACP精确load。MCP凭据仅给所需原生工具进程，不放Router或业务提示。

每任务独立目录，Agent原文仅过滤秘密后回一条结果+完整TXT，用量在下载文件；模型声称的其他文件路径不自动上传。通用代码检查针对给定材料，项目worktree/PR仍由旧代码Worker维护。本轮不宣称任意项目自动修改/发布或插件市场已经实现，工作目录隔离也不是OS沙箱。

## 三原生Agent复验入口

可提交脚本为environment/scripts/verify-agent-reviews.mjs及agent-review-mcp.mjs；原生账号沿用本机配置，不复制密钥。先在Node24.9+和PS7环境准备只含源码/测试的三份独立快照：

```powershell
node environment/scripts/verify-agent-reviews.mjs --config environment/config/bridge-installed.local.json --prepare --source-frozen
node environment/scripts/verify-agent-reviews.mjs --config environment/config/bridge-installed.local.json --run-agent dsh --live
node environment/scripts/verify-agent-reviews.mjs --config environment/config/bridge-installed.local.json --run-agent pi --live
node environment/scripts/verify-agent-reviews.mjs --config environment/config/bridge-installed.local.json --run-agent hermes --live
```

prepare为零模型本机准备；run-agent必须显式live才发真实模型。输出默认environment/verification/agent-reviews，完整原生/账号路径不提交。每代冻结工具源码、固定套件命令、Node/PS路径与源码哈希；审查Agent须实际调用MCP，报告nonce/测试stdout/SHA与native工具事件交叉核验，源变化即拒绝验收。Agent审查建议由协调者复核，不等于已复现缺陷。
