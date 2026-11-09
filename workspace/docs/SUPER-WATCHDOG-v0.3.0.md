# v0.3.0 独立语义 Watchdog

## Windows元数据共享访问修正（2026-11-09，实施前记录）

实际GitDelivery独立副本验收连续两次暴露owner运行元数据rename的EPERM：原1.575秒共享重试预算耗尽，Watchdog因此停止，不能把该验收记作通过。保留既有失败日志。本轮仅扩充原子替换工具的可选、有界退避参数，默认调用预算不变；Watchdog owner元数据选8.075秒共享重试，总预算不超过10秒且远小于90秒心跳失效门槛，每次尝试仍重核本进程状态租约。非共享错误和owner变化立即失败，不改为忽略写入或虚报更新。

重复定时心跳只允许一个待完成发布，避免共享锁期间排队数十次；明确状态变更与最终停机记录仍按顺序等待真实持久化。验证使用独立临时目录、真实PowerShell FileStream以FileShare.Read锁目标超过2秒，再证明释放后原子替换及监督心跳恢复；同时验证owner失效与非共享错误不被重试。运行中的本机0.3服务不因本修正重启。

针对验证 `node --test bridge/test/super-file-replace.test.mjs` 从workspace运行4项通过：实际FileStream持有3.2秒后完成原子替换；owner变化在下一次重试立即拒绝；ENOENT不等待重试；真实Watchdog在共享拒绝超过2秒时保持运行，解锁后确实发布新心跳并正常停止。随后与既有watchdog/lifecycle联合回归37项全部通过。没有略过原断言、吞元数据写失败或反复重跑全量测试；此前两次GitDelivery验收失败保持原记录，修复后的实际任务交付由根代理另行执行确认。

2026-11-09，编码前设计。总范围见 `SUPERAGENT-v0.3.0.md`。本模块由独立 Node 进程运行，不依赖主调度循环的定时器；它的状态、锁、只读模型会话和运行日志与控制器及编码 Worker 分开。

## 输入与权限

- GET `/api/supervisor/snapshot` 读取控制器 generation/heartbeat 和任务目标、进度、实际差异及测试证据。POST `/api/supervisor/actions` 只提交受限动作，Authorization 从 `SUPER_AGENT_CONTROL_TOKEN` 环境变量取得；远端必须 HTTPS，禁止重定向到别的 origin。
- 任务资料、源码差异、工具输出均是不可信观察资料。模型只读，只能返回 `taskId/action/reason/instruction`，动作仅 `observe/steer/pause/restart_controller/notify`。不执行模型返回的命令，不给模型凭据、配置写权限或任意网络能力。
- 读入和模型提示均限制体积；每轮最多评估四个符合条件的运行任务，轮转避免饥饿。分类采用独立 installed-headless executor 的 read-only 模式，不复用编码 Worker 或其会话。

## 语义与控制回路

- 定时判断 Worker 是否朝可信任务目标推进，结合实际进度摘要、工具类别/重复频率、diff 和测试结论，而非仅以进程存活判断。
- 模型建议先严格校验。相同证据稳定生成 action id，先在本机持久化待发送动作，再调用控制器；确认丢失重发相同 id，不能重复干预。
- 正常 observe 同样静默写回控制器，便于人员询问监督结论；不向项目群发送每轮正常检查结果。来源异常和过期心跳以 taskId=null 的通知汇总，同一代控制器的相同故障不反复打扰。
- 对同一任务/attempt最多自动 steer 一次；下一次仍建议 steer 时提升为 pause。最少冷却时间和每轮预算限制模型/干预次数。处于 paused/uncertain/failed 的任务不自动恢复，不因模型错误重做代码。
- Controller 的动作端再次检查 generation、任务当前状态和动作去重。独立 Watchdog 不修改主任务账本；它的意见不会自动成为任意系统操作权限。
- 每轮持久化可供诊断的简短中文/结构化状态；分类失败有有限连续故障预算和退避，达到预算后持久标记 modelBlocked，需检查模型配置并在停止监督进程后明确清除此标记再启用，不能静默伪装成任务正常。控制器不可达时保存 needs_attention 及错误，不调用模型浪费请求。

## 进程故障恢复

常规主进程失联由部署服务管理器重启。可选 `restart` 登记本机命令，只接收可信配置中的 `runtimePath/instanceId/executablePath/args/cwd`；登记 runtime 必须具有相同 nonce、exe、args，且 PID 已确认不存在。PID 仍在、身份不符、登记缺失或权限无法确认时仅记录需人工检查，不杀进程、不删锁、不自动运行任务。重启限次数及冷却，启动参数绝不来自模型或聊天。

监督进程自己的状态租约可在严格证明后恢复：旧 Node PID 必须已不存在，登记 origin/statePath/tokenHash/exe/PID 必须匹配，且独立 runsPath 中每个已接纳分类器都有已完成或进程树已停止的证据。只发现 Node 死亡不够；旧分类器仍running、launcher仍存在、终态缺失、证据目录身份异常时保留租约并要求检查，不启动第二个原生分类器。控制器与 Worker 的任务/工作目录锁不由监督恢复代码清理。恢复保护锁本身的异常遗留仍需核验。

## 对外契约

`SemanticWatchdog({snapshot,act,classify,now,config,state?,save?}).tick()` 返回 `{status,assessed,actions,diagnostics}`。`snapshot` 返回 `{generation,heartbeat,tasks:[{id,status,summary,instructions,updatedAt,progress,attempt}]}`；progress 可含 `at/summary/tools/evidence/diff/tests`。`act` 接收 `{id,taskId,action,reason,instruction?,generation}`。

`startWatchdog(config)` 启动独立轮询服务，返回 `{watchdog,stop,completion}`；配置含 controllerUrl、tokenEnv、绝对 statePath、harness 配置和可选时间预算。CLI 为 `node super-watchdog.mjs --config <json>`。认证值不写入配置示例/日志。状态保存在忽略目录，不进入 Git。

进程登记默认写入 `statePath + '.runtime.json'`（可配置 ownerPath），包含 pid、随机 nonce、控制器 origin、statePath、tokenHash、exe/argv、heartbeat、startedAt 和状态，不含 token 明文。心跳独立于模型调用，最多间隔5秒，主控制器重启时可据此复用仍在运行的监督进程。Windows 停止使用继承 IPC `{type:'stop-watchdog'}`，或在 `ownerPath + '.stop'` 写入 `{pid,nonce}`；250ms检查且必须匹配当前实例，先回收只读执行器再释放状态锁，元数据最终标记 stopped。旧 nonce 的停止请求不会影响新实例。

## 验收标准

1. 真实临时 HTTP 服务验证 bearer、GET/POST、origin 与重定向限制，以及确认丢失后使用同一 id 重试。
2. 假分类器验证实质进展/无效循环/跑偏、注入内容与畸形 JSON、未知 task/action、跨 generation 拒绝、一次 steer 后 pause、不恢复 uncertain 任务。
3. 临时状态与文件锁验证跨进程排他、模型预算/公平性、失败退避、持久 pending 动作和重启去重。
4. 受控短进程验证仅登记命令可重启；存活或身份不符不重启。测试不访问模型、不使用真实群、不改现有运行服务。真实只读模型验收需根代理显式限定次数执行，不能用上述测试代替。

## 本模块实现验收

`node --test workspace/bridge/test/super-watchdog.test.mjs` 最终21项通过，包含真实临时HTTP、单独Node进程调用PowerShell假DSH（只验证原生协议，不调用模型）、只读权限/控制token环境剥离、确认丢失后的同ID重发、模型故障上限、一次纠偏后暂停、运行中监督心跳与nonce停止、固定登记命令的已死PID恢复，以及监督自崩溃后的原生终态证明门禁。

第二轮独立生命周期审查新增 `test/super-lifecycle.test.mjs`，最后12项通过；与本模块合计33项通过。验证真实独立监督进程的复用/停机、控制器runtime死亡恢复与归档、显式stop优先、身份/凭据/心跳真实性、状态租约并发恢复、HTTP能力隔离与引用链接分页、较早活跃任务的监督覆盖及长历史快照预算。该审查未修改主控制器/协调器文件；发现的运行时恢复记录竞态、停止门禁、attempt开始时间和续读分页问题由根代理修正后复验。

复用监督进程还必须验证实际OS进程身份。Windows用固定PowerShell/CIM查询指定整数PID的exe、CommandLine和CreationDate，通过原生CommandLineToArgvW解析完整实参，再与登记值和startedAt校验；登记字符串不拼进PowerShell源码。Linux读取`/proc/<pid>/cmdline`与exe链接，校验完整实参和真实可执行文件。活PID或仍新鲜的JSON单独不能证明可复用；替换成另一个同exe活Node PID、伪造args或创建时间都会被拒绝，不停止任何被查询进程。

首轮17项测试中，短Node恢复夹具尚未退出就清理其cwd，导致Windows EBUSY；修正夹具为等待子进程close后清理，复验通过。未将该夹具清理错误描述成产品故障，也没有删除真实进程/锁来制造通过。本模块未执行真实模型判断，实际模型/全流程集成由根代理另行限定并记录。

新增真实崩溃夹具首版错误假定：杀死监督Node后，PowerShell假分类器一定会自然完成并写终态。本机观察为PowerShell也退出却没有终态，因此等待失败。最终改为验证实际应满足的约束：无终态时保留原租约，新监督的分类调用为0，不擅自重跑。失败测试的临时HTTP清理也已补齐；未放宽产品证明条件。失败现场保留在本机临时目录，不提交原始日志；最终32项复验通过。

根集成从workspace运行时另暴露夹具路径问题：原fixture按cwd拼接workspace/bridge，导致重复workspace路径，且等待ready失败前尚未登记HTTP清理，测试进程因此挂起。入口已改为import.meta.url定位，清理在等待前注册并先停止子进程/关闭HTTP再清目录。从生产workspace工作目录执行lifecycle与watchdog测试，最后33项全部通过；此前挂起测试树由根代理核验PID/exe/argv/父子关系和创建时间后精确结束，未停止真实服务。
