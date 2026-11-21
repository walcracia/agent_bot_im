# Carota QA 与 OTA 日志分析来源核对

2026-11-21补充实查：用户本机原插件内嵌skill已更新为1.3.2，核心脚本、SKILL及判定/时间文档与本项目固定包hash相同；下方1.2.0为早期只读快照。新配方对照原index.js的整包runTriageOn、evidenceSnippets、compactVerdict、keyLineHits及analyze提示/prepareCall，低/中/高三档纯函数和system/user逐字比较。不能再把当前结果差异归因为旧技能版本。实际QA流程因用户暂停等待VPN，模型等价验收尚未完成。

核对日期：2026-11-20。仅查看用户指定来源、本机插件实现和工具声明；不读取真实缺陷/日志/私人会话/认证缓存，不启动模型或分析，不修改原有DSH安装。本文件为脱敏实现依据，不是日志分析或正式监听已经成功的验收报告。

## 已定位的本机实现

路径中的 `~` 指当前用户目录，`$DSH_HOME` 默认是 `~/.dsh`；换机器后须重新发现，不能把本机路径视为Git提供的依赖。

| 部件 | 本次读到的版本 | 入口 |
| --- | --- | --- |
| 截图中的“奇瑞问题分析”插件 | `@local/chery-qa` 0.1.0 | `$DSH_HOME/profiles/desktop/node_modules/@local/chery-qa/`，`package.json`、`cordis.patch.yml`、`index.js`、`client.js` |
| 插件内嵌分析skill | ota-log-triage 1.2.0；parser基线log-analyzer v2.19.0，移植日期2026-11-11 | 插件目录下 `triage/SKILL.md`、`triage/scripts/version.js`、`triage/scripts/triage.js` 和 `triage/references/` |
| 插件调用的本机QA MCP | qa-server-mcp 1.0.5 | `$DSH_HOME/mcp/qa-server/node_modules/qa-server-mcp/dist/index.js`，工具声明在 `dist/tools/` |

以上版本来自包清单/版本源码读取，未执行CLI版本探测。Desktop profile已声明该本地插件bundle；没有操作已有窗口或对话。

插件host入口本次SHA256：`68cd1dfd8e22ee88962faf42ca76bdb3444921ed99cd6db9f123a78395884f5b`。内嵌SKILL.md SHA256：`d86a4a13a583926e869d376bfdc0e2b7fcc53ae7769399f11d6d040fa8056dfc`。这些标识用于区分本次查看的副本，不代表上游签名或安装完整性认证。

## 用户指定的发布来源

- 公共skill发布页：[ota-log-triage](https://list.notmmao.com/ota-log-triage/)。本机HTTP读取可达；网页检索工具不能直接打开。核对时最新为 **1.3.2（2026-11-19）**，不等于本机已升级。
- [1.3.2发布说明](https://list.notmmao.com/ota-log-triage/1.3.2.html)及[安装包](https://list.notmmao.com/ota-log-triage/ota-log-triage-1.3.2.zip)：安装包144,547字节、24文件，SHA256 `3be41e8de6d60ace8f22c99469854023bc8ed4622d212998eea2be9b5f057e17`。只在内存中查看目录、skill和版本源码，未安装、解压到项目或执行脚本。
- 用户提供的内网npm registry在本机可读取包元数据；本文件仅以 `<qa-registry>` 表示，实际地址留在操作者本机配置，不发布。包端点为 `<qa-registry>/qa-server-mcp`，页面为 `<qa-registry>/-/web/detail/qa-server-mcp`；核对时latest为 **1.0.6**。stdio入口为 `qa-server-mcp` / `dist/index.js`；该包描述为只读QA查询工具。
- registry说明明确1.0.6新增列表 `pageSize` 最大200的客户端保护；本机1.0.5的工具声明尚无此硬上限。新的监听器应自行限制分页和总量，不能假定旧安装已包含新保护。

skill 1.3.2继续使用同一parser基线，更新了分析规则：缺陷报告时间不能直接当故障起点，应追溯版本首次启动；描述中的因果预设需用证据核实；TBOX与QNX/DE的时钟域要分别确认，不能一律把slave-da视为UTC。自动分析前应固定版本与规则来源，不能混用1.2.0文档和1.3.2结论，亦不能静默改写用户已安装副本。

## QA MCP与新增Bug发现能力

本次查看的MCP工具与插件调用包括：

- `projects_list`：项目列表，供显式选择允许监听的项目。
- `issues_list`：按 `pId`、`status`、`id` 等查询，支持 `pageIndex/pageSize/sortBy/sortOrder`；插件UI允许按 `id`、`openedAt` 等排序。
- `issue_process`、`issue_comments`、`issue_files`：按 `isId`读取流程、评论、附件ID。
- `file_url`：按附件ID取得下载地址；在元信息可读时返回名称、类型、大小和md5，否则仍可能只返回URL。下载后应另算SHA256，不把缺失的元信息当作已经验证。

**所见MCP声明没有 `createdSince/updatedSince`、事件cursor、订阅或webhook接口。** `issues_list`也没有可依赖的revision契约；插件公开投影有id/no/status/openedAt等字段，评论与流程各有id/时间，但不构成已验证的事件流。后端排序稳定性、分页快照和重开/新附件变更语义尚未用真实业务数据测试。

因此不能将 `status=new` 的全列表直接交给模型，也不能仅凭第一页最大ID保证不漏。设计应限定项目、首次建立完整基线、持久化发现ID及处理状态、分页重叠与去重，并为断线/缺页保留补偿扫描；具体保证取决于后续接口契约验收。新附件和重开应使用单独的变更规则，不冒充“新建缺陷”。

## 插件当前的真实分析链路

1. 用户在UI点击单附件、全部附件或上传分析。`client.js`先请求解析，再请求模型复核；没有持续新Bug监听或后台任务账本。
2. `index.js`中的 `/chery-qa/api/triage/issue` 读取指定缺陷附件ID（当前最多取30），下载日志；`/triage/file`处理单附件，`/triage/upload`处理本地上传。zip由固定 `tar` 参数解包，文本按内容识别，不仅看扩展名。
3. `runTriageOn`调用固定Node脚本，取得JSON，保存本地 `.triage-result.json` 与runId。HTTP解析响应会删去verdict/findings/suggestions，不能把这个精简响应当作完整证据。
4. `/chery-qa/api/triage/analyze`读该runId的解析结果、skill/references及证据附近真实行；依努力等级限定证据数量与模型输出预算，再通过DSH宿主的 `llm.prepareCall().stream()`生成报告。
5. 实际报告固定为五段：结论、依据、时间线、其他可能、下一步；包含责任方倾向、置信度与文件/行号。模型响应返回给UI状态，未见最终报告持久化、IM发送或发送去重；CLI解析记录不等于完整分析结果已持久保存。

`index.js:427–444`通过 `ctx.webServer.register`注册上述UI内部路由，`runAnalysis`是依赖DSH宿主服务的闭包函数（约1047–1158行）。它们**不是QA MCP工具，也不是已验证可从后台调用的公开Desktop API**。本次未探测Desktop访问认证或发请求，不能猜测私有端口/令牌并直接接入。模型复核是纯LLM调用，没有获得Agent工具；共享trace/sessionId也不等于每缺陷的可恢复原生Agent会话。

完整缺陷正文另经插件 `/chery-qa/api/issue-body`读取QA页面内嵌issue，所见MCP没有独立 `issue_get` 工具。后续应验证列表/评论能否提供所需描述、时间、环境；不足时请求补充或另做受控只读适配，不能继承插件的默认登录身份或抓取逻辑作为既定契约。

## 可复用的命令与边界

下列是源码/skill中定义的命令接口示意，本次未运行：

```text
node <skill-root>/scripts/list_logs.js <日志包或目录> --date YYYY-MM-DD --from HH:mm --to HH:mm
node <skill-root>/scripts/triage.js <日志包或目录> --date YYYY-MM-DD --from HH:mm --to HH:mm --effort low|mid|high --json
node <skill-root>/scripts/parse_log.js <文件或包> --date YYYY-MM-DD --sections cloud,rpc --json
```

脚本为CommonJS，插件有 `triage/scripts/package.json` 的 `type:commonjs`标记；迁移到ESM目录时必须保留模块边界。可复用固定parser CLI、结构化发现和证据行号、skill判定/复核流程；自动调度应经Trigger→Router→专用只读分析Worker，不交给代码修改/自动合并通路。模型复核可用受限headless任务或新的受控适配器，需单独验证，不操纵用户现有Desktop会话。

不宜原样复制的部分：当前附件下载使用完整 `arrayBuffer()`，未见下载字节/时间和解包后总量/压缩比/路径边界的完整保护；UI上传128MiB上限也不同于同频每文件严格小于100,000,000字节的规则。正式适配必须限制下载源、总量、文件数、解压路径和时间，隔离不可信内容，按最小证据将日志交给模型。缺少明确问题日期/时间时应等待补充，不拿openedAt填充案发时间，不把缺证据写成确定根因。

插件没有Trigger、持久任务、增量游标、失败恢复或IM Outbox。自动版本必须另建每缺陷Thread、稳定任务/输入版本、解析/模型/报告阶段记录、结果缓存和输出去重；发送失败只重发已保存结果，不重新付费分析。只写回授权聊天，QA仍为只读，业务原文/日志/下载URL/凭据不提交公开Git。该插件标为private，不在本轮复制整包或专有源码到仓库。

## 本次访问范围

已完成：本机包/源码静态核对、给定发布页与ZIP内存读取、内网registry元数据读取、已连接QA MCP工具声明核对。未做：真实QA项目/缺陷/附件查询或下载、模型调用、parser运行、自动监控启用、对QA写入、日志内容检阅、DSH更新、私有HTTP调用、真实端到端验收。
