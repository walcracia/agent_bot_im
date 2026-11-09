# v0.3.0 Super-agent 执行层设计

2026-11-09。实现前冻结；任务协调器另见主规格。

- 每项任务使用独立 Git worktree、`codex/super/<任务ID>` 分支及独立的原生 DSH session 映射。任务恢复必须验证工作目录、分支和映射；不 reset、删工作副本或清除旧锁。
- 自动合并启用后的新任务可由可信配置设置`refreshBase:true, baseBranch:'main'`：每个新任务创建前单次参数化fetch固定origin/base，验证remote-tracking引用与远端SHA后从该完整SHA创建worktree并持久baseCommit。只更新远端跟踪引用，不pull/reset开发者主检出，也不覆盖其脏文件。首次fetch或SHA确认失败不创建任务worktree；恢复已有任务仍沿用原base，不擅自升级。默认false保留本地HEAD验收行为；Git代理仅用于该次调用，诊断留忽略运行目录。
- `TaskWorkerPool.prepare(task)` 返回持久化元数据；`start(task,{onProgress})` 在进程完成前返回 `{completion}`。协调器限制并发数。每项任务单独拥有 executor，代码任务上限仍为两小时。
- `input(taskId,input)` 将输入以稳定 ID 持久化到任务 inbox，由附加 Cordis 插件调用实际 Agent 的 `steer`（next-step），在下个可接纳输入的步骤送入原会话。只有插件从原生`user/message`事件确认并写入持久接纳记录才记 delivered；未接纳输入在恢复时补送。模型执行细节仅在本机保存。
- `cancel(taskId)` 仅终止本实例拥有的原生进程树，并核实退出；无法证明停止则保留互斥锁，拒绝续跑。输入补充不通过强制杀进程实现。
- 执行环境只接受可信配置中的项目路径、根目录、CLI、基础引用及权限。聊天文本只作为序列化数据，不拼接进 shell。worker 不继承 IM 或协调器控制令牌；只接收本任务的上下文续读凭证。
- 可选 HTTP daemon 使用独立环境令牌、固定项目注册和 HTTPS（仅 loopback 可 HTTP）。除原生 worker 接口外提供受限文件读取、写入和参数化命令执行；MCP stdio 代理使云端模型循环直接调用端侧工具，端侧不必保存云端会话日志。命令权限来自可信配置，任务不能更改。远程工具不是 OS 沙箱，应使用受限系统账户。

验收：临时真实 Git 仓库的两个任务目录/分支隔离；实际 PowerShell 假 CLI 验证非阻塞启动、原 session 恢复、输入去重、进度与取消退出证明；HTTP 验证身份、路径逃逸/链接、参数边界及幂等；MCP 验证 initialize/tools/list/tools/call。常规测试不调用真实模型。实际 DSH 插件验收另显式执行并限制会话次数，不将协议夹具当模型实测。

## 配置与接口

本机默认 `TaskWorkerPool`；`RemoteTaskWorkerPool` 将原生 DSH 运行委派给执行机器；`CloudTaskWorkerPool` 将模型循环与持久会话保存在控制侧，只通过 MCP 调用端侧工具，控制侧的 `agent-cwd` 保持为空，不复制项目源码。后三者的 `start` 都先返回 `{completion}`。控制侧运行目录应放在持久卷中；“模型循环与文件环境分离”不等于无需持久会话存储。

端侧入口：`node workspace/bridge/super-daemon.mjs <配置JSON>`。配置路径相对 JSON 目录解析，token 由 `tokenEnv`（默认 `SUPER_AGENT_DAEMON_TOKEN`）读取，至少32字符，不写示例或 Git。示意：

```json
{
  "host": "127.0.0.1",
  "port": 18203,
  "repositoryPath": "../tools/project",
  "worktreesPath": "../data/super-worktrees",
  "runsPath": "../data/super-daemon",
  "sessionMapsPath": "../data/super-sessions",
  "tokenEnv": "SUPER_AGENT_DAEMON_TOKEN",
  "maxWorkers": 2,
  "commands": {
    "test": { "file": "<绝对Python解释器路径>", "args": ["-m", "pytest"], "allowArgs": false }
  },
  "harness": {
    "cliPath": "<端侧DSH CLI绝对路径>",
    "auth": "stored",
    "runTimeoutMs": 7200000
  }
}
```

`commands` 是可信部署者定义的命令表，调用者只选择名字；默认不允许追加参数、不开 shell、不继承环境密钥。复杂工具链所需环境应由可信配置显式提供。禁止路径穿越、`.git`/`.env`读取与符号链接逃逸；这仍不是操作系统沙箱，需要按项目风险使用受限账户。非loopback地址必须通过明确配置的TLS代理；远端控制器拒绝普通HTTP远程地址。

控制接口使用主凭证；工具接口使用从主凭证与taskId派生的单任务凭证。`/prepare` 创建或验证任务worktree；`/start` 按 taskId/attempt 去重并持久保存结果；`/inspect` 读取结果；`/input` 持久接收补充；`/cancel` 先撤销Git交付权限并终止端侧受管命令，再停原生worker；`/delivery` 仅使用本机可信GitHub配置及已登记目录。daemon重启后运行中尝试标作中断，不盲目重跑。

`super-mcp.mjs` 提供标准stdio JSON-RPC `initialize/tools/list/tools/call`，工具为 `read/write/exec`；存在任务上下文地址时额外提供 `context_read`，以原引用ID与offset续读。配置使用 `SUPER_AGENT_ENVIRONMENT_URL/TOKEN`、`SUPER_AGENT_CONTEXT_URL/TOKEN`、`SUPER_AGENT_TASK_ID`，只传单任务凭证。`CloudTaskWorkerPool` 自动生成MCP覆盖配置并关闭原生文件、搜索、shell、jobs、技能、subagent和插件管理工具。端侧工具配置不包含云端会话记录。

## 本轮验证记录

- `node --test workspace/bridge/test/super-worker.test.mjs`：9项通过，包含真实临时Git、HTTP、stdio handler以及实际PowerShell假CLI；不是模型验收。覆盖未跟踪源码再次编辑进展、任务限定上下文链接续读、远端重启后的未确认命令阻断。
- 既有 `installed-headless.test.mjs`：19项通过。首轮因PowerShell将空JSON数组枚举为null导致13项失败，改用`ConvertFrom-Json -NoEnumerate`后全部复验通过。
- 使用本机签名DSH0.2.2-rc.1和真实Cordis inbox插件，以故意无效的权限preset在创建Agent前失败，验证原生插件导入/挂载，零模型。首轮发现timer令已结束headless进程不能退出；确认只属于该探测的进程树后终止，增加timer.unref，再次于2.6秒正常返回预期权限错误。此检查不是实际模型读取补充的证据，真实live steering由集成验收另记。
- 真实DSH与MCP stdio插件组合亦在同一零模型权限门禁前成功挂载，3.1秒退出，无协议错误。
- 首次显式真实验收只使用T900001/T900002两个会话。两个原生会话并行；A收到补充后真实新增`offset_result(value)=compute(value)+17`，两任务独立断言/pytest、原测试不变和仅fixture修改均通过。但整体报告失败：未写input receipt。只读本次A的原生日志确认`user/message`已消费同一messageId；事件的data直接是message，修正原来误读data.message。另将next-turn的followup改为已核实的next-step steer。原失败报告保留，修后真实next-step验收需另经协调器显式预算，未自行增加模型调用。
- 根协调随后明确追加原A会话一次turn，未创建新session或重做B：实际原生inbox splice序号149、target=next-step，user/message消费155，receipt序号匹配且中间没有turn/end；offset由+17改为+23，独立断言/pytest及原测试不变、仅fixture修改全部通过。首轮失败和补验收报告分开保留。
- 根协调再明确授权一次remote-tools验收T900003。控制侧原生session在空cwd运行，实际只调用`mcp__task__read/write/exec`进行代码操作，没有原生文件或shell调用。源码只位于独立daemon worktree，控制cwd开始/结束均为空；独立断言/pytest、测试hash和端侧命令终态均通过。没有部署腾讯或新云服务器。
- 以上真实worker总预算与实际使用均为3个native session，另有原A一次明确追加turn；不含主协调另做的只读模型验证。复现入口`environment/scripts/verify-super-live.mjs`默认零调用，`--live`为双任务，`--live --resume-from <旧验收目录>`为显式原A补验收，`--remote-tools-live`为单个MCP端侧任务。原始日志和账号不提交。
- 远端工具命令增加持久prepared/running/termination-failed账本，异常重启后不凭缺少内存进程记录而重新执行或声称已停止。测试发现成功HTTP响应早于finished账本写入的窗口，已将响应移到提交后并复验。远端媒体附件运输/模型理解未在本轮真实MCP验收中覆盖；本机默认路径继续传入既有校验后的附件metadata。
- 自动合并后续任务基线补验收：当前worker模块11项全部通过。真实临时bare origin先为A，task1固定A；另一检出推送B，本地主HEAD仍A且有未提交文件，task2确认并基于origin/main=B创建，原HEAD与脏文件未变；既有task1仍A。随后使origin不可用，新task明确失败且无分支/账本，不退回旧tracking ref。Git代理仅存在于fetch/ls-remote调用参数和子进程环境，父进程代理未变。此次仅本机临时Git、零模型/零真实GitHub写入。
- 最终冷副本gate曾出现255/256：native inbox全部功能断言通过后，夹具清理receipts目录遇到ENOTEMPTY。原因是dispose只停timer、不等待已开始的poll，且fixture的删除钩子先于插件停止钩子。修正方案为显式disposed门禁和跟踪当前poll，异步dispose等待该poll结束；夹具在finally先await两个插件的dispose，再交给已有临时根删除。保持原消费、去重、恢复全部断言，不用sleep或无界重试掩盖竞态。原始失败诊断保留。修正后targeted worker 11项、语法及diff空白检查全部通过。
