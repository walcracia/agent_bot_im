# v0.3.0 · Super-agent 验收

日期：2026-11-09，Windows，Node 24.19.0、项目Python 3.12.15、已安装DSH 0.2.2-rc.1。源码/实际运行/远端交付分别确认；此文件为提交前快照，最后状态以Git及运行记录查询为准。

## 本轮结果

- `environment/scripts/verify.ps1`及其后的最终桥接回归：26 Python、208 Node、16 Windows编排及客户端/桌面JS语法通过。旧Starlette/httpx弃用警告保留。
- 新模式真实入口：Node控制器、独立Watchdog、隔离HTTP IM、PowerShell假DSH和临时Git，验证两任务并发、执行中状态/停止、一项取消不影响另一项、nonce正常停机、旧账本不覆盖。它是实际进程/传输测试，不是模型编码证据。
- 冷工作副本独立验证：无副本venv/node_modules，显式可信解释器运行26 Python与当时快照200 Node；源码/测试/索引指纹不变。最终主检出已另外通过207 Node。具体脚本 `verify-task.ps1`。
- 真实只读模型：Router一个会话正确判定明确新任务与“已解决不要修改”；独立语义Watchdog一个会话对明确标注的合成停滞事实给出steer。没有宣称监测到生产故障。
- 真实本机编码：T900001/T900002两个原生会话同时运行，修改各自隔离微型夹具，独立断言/pytest通过，测试文件hash不变。原A追加一次已明确限定的原会话turn，补充在 `agent/inbox/spliced target=next-step` 后被 `user/message` 消费，序号与持久receipt一致；实际代码offset由17变23。
- 真实环境分离：T900003一个原生会话/turn，只调用 `mcp__task__read/write/exec`；控制侧cwd始终为空，代码只在本机独立daemon工作副本，固定测试命令、外部断言/pytest通过。
- 实际预算：3个原生worker会话、4次worker invocation（含原A一次追加turn），Router与Watchdog各1个只读会话。不推测模型内部请求量或费用，不无限重试。
- GitHub/发布：真实临时Git提交/推送/构建+模拟gh，验证PR/评审/CI、丢确认只读核实、准确head合并门禁、已合并commit独立构建、tag/资产冲突拒绝覆盖；实际远端交付另行查询记录。
- Windows0.3.0已构建：PE/manifest版本、asar9条目白名单、6个源码文件逐字节一致。完整ZIP74文件，CRC及每文件hash一致；不含服务器、DSH、凭据或运行数据。普通界面沿用已验证蓝色设计，未重做UI。

## 修正及失败记录

- 原生初版把user/message读取成data.message，且followup是下一轮而非下一步。首轮模型编码通过但receipt断言失败，原报告不改写；修正data结构和steer后，用真实既存事件离线回归，再仅追加原A一个turn实证通过。
- 原生插件首次零模型预检出现定时器保持进程存活，改为unref；inbox与MCP挂载随后均通过真正签名CLI的零模型预检。没有把预检称作实际模型工作。
- 冷副本首轮旧HTTP测试找不到副本venv，使用既有IM_TEST_PYTHON入口显式指定可信解释器后通过，未改测试绕过。
- 首轮完整verify的测试夹具依赖仓库根cwd，从生产workspace运行时拼出重复路径并泄漏HTTP监听。核验exe/argv/创建时间后只终止该测试树，改为import.meta.url与预注册清理；最终正式入口207 Node通过。
- 后续增加离线重连用例后，一次全量Node运行的SQLite临时目录清理遇EBUSY；功能断言未失败。改为等待子进程close并只对该隔离目录有限重试清理，最终208项通过，不重复执行模型或放宽断言。
- ZIP首轮错误沿用旧包75文件数量断言；实际新目录/ZIP均74，逐文件一致。旧目录多出的仅debug.log，新包未带该旧运行日志。

## 实际交付前的Windows补充修正

实际T900004冷副本交付验证拦截了Watchdog owner元数据rename的EPERM，原1.575秒共享重试预算耗尽。默认任务/状态替换预算保持不变；仅监督元数据改用8.075秒、每次重验owner的有限预算，并合并重复定时心跳。真实FileStream禁止delete-sharing锁3.2秒后原子更新成功；锁住期间监督不退出，解锁后新心跳与正常停机通过；owner变化和非共享错误仍即时拒绝。原失败日志保留，不放宽验收断言。

实际空闲控制器崩溃测试发现Windows子进程作业会回收未detached的监督进程；现双方独立启动，复验原Watchdog存活、恢复原runtime nonce/账本、更新新控制器的CIM登记、正常nonce停机均通过，零模型。另为命令失败增加仅本机的私有diagnostics及cause，避免只剩泛化错误；测试/构建剥离IM、监督、执行端和模型/GitHub凭据，git/gh仅保留其必要认证。补充模块回归分别为4项实际锁测试、33项监督/生命周期、27项GitHub/发布/服务测试；最终冷副本交付检查另行记录。

## 运行与交付边界

用户明确继续本机，本轮不部署腾讯。默认最多2项并行、每项2小时，分类2分钟；监督独立、只读、有界纠偏。权限/原会话/进程终态不确定时暂停，不能用删除worker锁或换session恢复。远端媒体理解未纳入本轮真实验收。

用户已明确选择可信测试通过自动合并。本机使用显式`mergePolicy=verified-tests`：固定可信验收不能为空，配置的远端检查仍须对当前head成功；默认review策略继续要求检查和可信评审。最新base同步后复验，版本在可信交付层顺序维护，空任务不生成版本。发布必须显式配置固定构建命令/产物和有效新版本。未授权策略不会由聊天放开；合并后发布失败单独显示，不把已合并代码改回失败。新模式先保留旧配置/账本，再启用独立状态；原聊天数据不提交Git。

## 最终策略补充

静默主动核查、fresh-base、已合并任务后续修正及关闭PR明确接续已集成。额外一次只读真实分类正确返回普通缺陷speculate、明确请求new，零worker、零重试；因此本轮只读Router共两会话、Watchdog一会话，worker仍3会话/4次invocation。最新模块回归GitHub30项、版本与Worker22项、协调器22项通过；全量回归/实际合并发布在最终交付记录追加，不覆盖前述历史失败。新增startup夹具裸rename遇共享EPERM，改为现有有限共享重试后11项通过，原stale-stop断言保持。

独立审查补充终态提问不启动编码、一次关闭PR恢复授权在确认交付后消费、远程执行端共享串行交付器/可信最新base与版本配置、离线投机任务保持静默。最终协调器25项通过。随后实际冷副本gate为256项中的255通过、1项清理失败：原生inbox功能断言通过，但插件dispose未等待正在写入的回执，删除临时receipts目录遇ENOTEMPTY。失败原始诊断留本机，合并被拦截；修正与复验结果另行追加，不能把这轮记作通过。

本机详细证据在忽略目录 `environment/verification/super-agent-v0.3.0`、`super-live`、`super-model`、`desktop-v0.3.0`。可复现入口与操作见 `workspace/docs/SUPER-OPERATIONS-v0.3.0.md`。
