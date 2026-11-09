# v0.3.0 · 本机 Super-agent 启用与运行

2026-11-09，脚本实现前约定。用户本轮继续使用本机，不部署腾讯。沿用现有 IM 18200、Windows 客户端及加密助手绑定；新模式的控制接口默认127.0.0.1:18202。IM仍是单进程服务，maxWorkers仅指独立编码任务数量。

## 安装与启用

先完成仓库接续、安装依赖和零模型验证。首次机器仍先用 `start.ps1 -ServerOnly` 建好 IM，再用 `connect-installed.ps1 -EnableStartup` 绑定群、成员和已有DSH。`enable-super.ps1` 只转换已有绑定，不代建账号、不取得或复制模型认证，不启动服务。

启用前正常停止监听。脚本与start/stop共用生命周期互斥，发现仍存活的本项目监听/Watchdog、无法核验的进程记录、旧账本current或旧/新状态锁时拒绝转换；不自动删锁、跳过旧任务或重试模型。

转换保留原始 `statePath` 及整个旧账本，另指定 `superAgent.statePath`、任务副本/日志/原生会话目录；先在忽略目录保存独立配置备份，再原子替换绑定配置。配置有明文认证字段时直接拒绝，不复制到备份；startup.credentialPath仅为已有DPAPI文件引用。

从旧模式转换时继承已确认的读取游标，避免切换期间的新消息被当作旧历史跳过；仍不复制旧会话冒充新任务。运行中可发送`任务列表`、`任务详情 #T000001`、`#T000001 补充要求`、`取消任务 #T000001`、`继续修正 #T000001`。需要共享相关反馈时用`关联任务 #T000001 #T000002`；关联仅限同一聊天，相关PR关闭不会终止另一项任务。

未启动任务遇执行设备离线时保留排队并退避重连；已可能产生副作用的未知原生调用保持暂停，不盲目重做。自动发布需配置ReleasePipeline、固定可信buildCommands及artifacts；Windows可用`environment/scripts/build-portable.ps1 -ToolchainWorkspace <已按相同锁文件安装的workspace>`在已合并commit的独立副本构建，产物为`outputs/TeamRelay-portable.zip`及校验文件。当前安装工具链与源锁不同会拒绝构建。

```powershell
# 在本项目根目录运行；先记录并结束/明确接续旧任务。
.\environment\scripts\stop.ps1
.\workspace\bridge\enable-super.ps1 -RepositoryPath (Get-Location).Path -MaxWorkers 2
.\environment\scripts\start.ps1
```

任务副本从 RepositoryPath 的已提交HEAD建立；开发版本应先提交。不要依赖主工作目录的未提交修改自动出现在任务副本。已有绑定群/成员不因启用模式改变。

## GitHub 交付

仅在显式传入固定 GitHubRepo、GitHub人员名单和可信验证命令时启用。工具参数来自本机配置，聊天不能修改仓库、命令或发布策略。测试必须是真正针对项目的验证，不用空操作冒充代码验收。

```powershell
.\workspace\bridge\enable-super.ps1 `
  -RepositoryPath (Get-Location).Path `
  -GitHubRepo 'owner/repository' -AllowedGitHubActors @('maintainer') `
  -TestExecutable 'pwsh' -TestArguments @('-NoProfile','-File','environment/scripts/verify.ps1')
```

默认创建/更新PR并等候评审。明确开启 `-AutoMerge` 还必须传 `-RequiredChecks` 和 `-TrustedReviewers`；实际只在指定head通过全部必需检查、可信人员在该head批准且没有要求修改时合并，不绕过分支保护。命令使用argv而非拼接shell。gh认证、SSH和模型凭据由执行机器自己保存，不在示例中填写。

自动构建发布独立配置为 `superAgent.release`，示例见 `config.super.example.json`，默认关闭。部署者明确设 `enabled=true/publishRelease=true` 并核对固定仓库、构建命令和完整ZIP产物后，PR合并触发独立release副本的构建、校验和Release发布。示例的PowerShell构建字符串是部署者固定的本机规则，不能由聊天提供或修改。ZIP包含整个便携目录与说明；版本来自已合并代码的workspace/package.json严格SemVer，worker需按项目规范更新版本。已有版本/tag不能覆盖，同版本其他commit会拒绝发布。详见 `SUPER-RELEASE-v0.3.0.md`。

PR已合并而发布失败时，PR仍保持已合并；发布单独报告失败和证据。未知构建副作用不会因一句“继续”就重跑；操作人员需核对原release副本和账本，或以修正后的新版本继续交付，不清空历史状态。网络丢确认仅在远端tag/asset状态能证明时恢复。

## 群里怎么用

普通讨论可识别新任务；每个任务有独立编号、工作副本和会话。两个独立任务可并行，群聊接收与路由不等待它们完成。多个任务时带编号可避免归属歧义。

```text
任务列表
#T000001 补充：空输入也需要覆盖
任务状态 #T000001
取消任务 #T000001
继续修正 #T000001
```

停止保留已经写入的代码；继续先检查原会话、实际差异和已完成步骤。运行中补充先持久化；原生会话支持时在步骤边界接收，回退路径必须证明旧进程退出后沿原任务接续，不能同时在同一副本启动第二个worker。PR评审/CI按绑定回到原任务；关闭或合并终止任务，批准和成功CI不会重新派编码。

## Watchdog 与故障

默认启用独立监督进程；它用独立只读会话查看目标、活动和证据，有界纠偏或暂停，并记录原因。连接失败、未知原生进程、旧锁或缺失会话均保留现场，不换会话假装恢复。先查看忽略目录的实例runtime、superstate和监督记录，再在原群明确继续。原始聊天/日志和状态不上传Git。

正常停止用 `stop.ps1`。它按记录核验拥有关系；未确认停止时保留现场，不手工删除锁来绕过。控制接口只监听回环；从其他机器访问应使用TLS反向代理和环境变量控制码，不把控制码放URL。

## remote-tools 同机隔离演示

此路径用于验证控制器与执行环境分离；两者可在同一台机器使用不同目录/端口。执行端固定一份已提交Git仓库、worktreesPath、状态目录及命令白名单。控制器端使用独立的context/control端口18202，执行端daemon使用18203，避免端口冲突。

将执行端配置保存于忽略目录，字段与 `SUPER-WORKER-v0.3.0.md` 对应：`repositoryPath`、`worktreesPath`、`runsPath`、`sessionMapsPath`、`statePath` 均为该执行端的绝对路径，`tokenEnv` 为 `SUPER_AGENT_DAEMON_TOKEN`，`commands` 只列本机信任的工具；不把shell作为允许任意附加参数的工具。

```json
{
  "host": "127.0.0.1", "port": 18203,
  "repositoryPath": "D:/Example/agent-bot-im",
  "worktreesPath": "D:/Example/private-execution/worktrees",
  "runsPath": "D:/Example/private-execution/runs",
  "sessionMapsPath": "D:/Example/private-execution/sessions",
  "tokenEnv": "SUPER_AGENT_DAEMON_TOKEN", "maxWorkers": 2,
  "commands": {
    "test": { "file": "C:/Path/To/python.exe", "args": ["-m", "pytest", "workspace/tests", "-q"], "allowArgs": false }
  }
}
```

路径是部署者替换的示意；remote-tools只经受限工具工作，不要求端侧再启动模型会话。若改用remote-native，则另为执行端配置自己的harness/DSH CLI。两个模式不能据此混称为相同的存算分离。

```powershell
# 在执行端终端设置自有随机控制码（不写进JSON或聊天），然后前台运行。
node .\workspace\bridge\super-daemon.mjs .\environment\config\super-daemon.local.json
```

控制器本机绑定配置将 `superAgent.executionMode` 设为 `remote-tools`，`superAgent.daemon` 设为 `{ "url":"http://127.0.0.1:18203", "tokenEnv":"SUPER_AGENT_DAEMON_TOKEN" }`，控制器进程设置同一环境变量。DSH计算和会话留控制侧，受限工具读写原地环境。跨机器必须使用HTTPS；离线保留排队和原任务，不能自动换目录或重建环境冒充接续。此文给出可复现操作，不代表已部署远程云端。

## 验证

`environment/scripts/verify-super-agent.ps1` 默认只运行新模块语法、Node隔离测试和PowerShell配置转换测试，零模型、零实际GitHub写入，不启动正式IM/监听。全项目验证继续用verify.ps1。真实模型与远程环境验收必须显式运行并记录数量、实际文件差异和独立测试证据。

脚本初次完整验证通过56项Node新模块测试及Windows配置转换夹具；后续新增的release/附件拒绝测试由同一入口自动纳入，最终数量以本轮实际输出为准。夹具验证未完成旧任务、旧锁、无法核验进程和内联认证均拒绝，成功转换保留原配置字节备份、新旧账本和可信嵌套argv。未转换本机真实绑定、未启动服务。
