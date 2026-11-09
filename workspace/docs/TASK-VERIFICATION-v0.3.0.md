# v0.3.0 任务独立副本验收

编码前设计，2026-11-09。DSH 每任务的 Git worktree 不包含被忽略的 environment/venv、node_modules；GitDelivery 的可信验收命令必须能在该副本直接验证候选源码。

## 命令与依赖

```powershell
pwsh -NoProfile -NonInteractive -File environment/scripts/verify-task.ps1 `
  -Python 'D:\Work\CodexProjects\agent-bot-im\environment\venv\Scripts\python.exe' `
  -Node 'C:\Program Files\nodejs\node.exe'
```

命令工作目录为任务worktree。Python必须是可信配置提供的已安装解释器绝对路径，含仓库锁定的服务/pytest依赖；脚本不会寻找或借用办公软件解释器。Node默认从PATH查找，至少24.9。实际源码一律来自脚本所在Git worktree，不来自解释器所属主检出。

当前桥接可靠性/Super-agent测试仅导入Node内置模块和本仓库模块；官方SDK只在真正启用OfficialExecutor时动态导入，常规测试使用明确的协议夹具。因此本验收不安装SDK、Electron或任何npm依赖，不读取/复制模型认证，不调用真实模型。

脚本同时把既有HTTP端到端测试支持的 `IM_TEST_PYTHON` 设置为显式解释器，让该测试启动当前副本的服务源码；退出恢复调用者原环境。它不会要求在每个worktree重新建立venv。

## 执行与验收标准

1. 定位当前worktree根，显式检查Python解释器和Node版本；Python导入位置必须是当前副本workspace/server/app.py。
2. 运行本副本Python API/备份测试、客户端/桌面与桥接JS语法检查、全部bridge/test/*.test.mjs（包括Router/Context/Coordinator/Worker/GitHub/Watchdog/生命周期）。
3. Python不生成字节码、禁用pytest缓存和外部自动加载插件；临时测试数据库位于独立系统临时目录，退出仅清理经绝对路径与非链接检查的本次目录。
4. 验收前后比较Git索引/状态及所有非忽略源码文件哈希，脚本不能改候选源码、测试或版本库；测试失败立即非零退出，不安装依赖掩盖问题。
5. 必须用真实临时独立Git worktree，确认没有node_modules和本地venv，再运行脚本。未提交的新候选文件仅逐字节同步到隔离副本，不改测试或替换实现；同步前后与根候选文件核对，运行前后源码指纹一致。该隔离验收不运行模型、不访问真实群。

## 实际结果

在本仓库 HEAD `4fa4170` 的真实detached worktree中逐字节同步180个当前候选文件，使用主检出明确提供的Python3.12解释器运行新脚本。确认任务副本不存在environment/venv、workspace/node_modules或workspace/bridge/node_modules。

首轮Python26项通过，Node200项中199项通过；唯一失败是既有 `http-e2e.test.mjs` 默认寻找副本内不存在的venv。仅在新验收脚本加入其既有 `IM_TEST_PYTHON` 环境覆盖入口，没有修改实现或测试。完整复验Python26项、Node200项、全部所选JS语法通过，源码/测试/Git索引/状态的前后指纹相同。未生成pytest缓存或Python字节码，没有安装npm依赖、调用真实模型或操作真实群。

原始首轮失败与最终日志、候选文件哈希清单位于本机忽略目录 `environment/verification/task-verification-v0.3.0-4bafba0cc8c84d8a81ab6ef64948907d/`。该结果对应当时复制的独立候选快照；后续根集成修改仍需重新验证，不能据此把未执行的新代码记为通过。隔离worktree保留供审查，不是生产任务副本。
