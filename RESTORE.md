# agent-IM 恢复与接续

项目根为本文件所在的 Git 仓库目录，可用 `git rev-parse --show-toplevel` 确认；不依赖旧电脑盘符。当前本机入口为 `D:\Work\CodexProjects\agent-bot-im`。

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

当前源码 UI 为 v0.1.3 蓝色主题，规格见 `workspace/docs/UI-v0.1.3.md`；布局与减负依据仍是 `workspace/docs/UI-v0.1.2.md`。完整浏览器回归运行 `environment/scripts/verify-ui-v0.1.2.py`，蓝色主题与对比度检查运行 `environment/scripts/verify-ui-theme.py`；两者都自动管理临时数据/服务，无需旧演示账号。v0.1.2 源码预览仍保留在 `outputs/design-preview-v0.1.2/index.html`，其截图是旧绿色主题的历史快照。

通用接续流程及独立安装方法见 [.agents/skills/proj_multihandoff/SKILL.md](.agents/skills/proj_multihandoff/SKILL.md)。

服务/桥接当前为v0.2.2，桌面客户端v0.2.3已构建并包含v0.1.3蓝色主题；完整目录/ZIP见outputs或v0.2.3 Release，交付验证见`outputs/VERIFICATION-desktop-v0.2.3.md`。接续自动编码先读 `workspace/docs/DSH-AUTO-v0.2.0.md`、`workspace/docs/STARTUP-v0.2.1.md`、`workspace/docs/DSH-RECOVERY-v0.2.2.md`、`workspace/bridge/README.md` 与本轮验收报告。默认 `environment/scripts/start.ps1` 同时启动或复用IM和已绑定DSH；首次绑定前用 `-ServerOnly`。绑定时 `connect-installed.ps1 -EnableStartup` 保存当前Windows用户加密的IM助手码，后续无需重复输入。真实团队的连接码/群绑定不在Git中，也不能跨Windows用户搬运密文；不要从测试日志推断监听已启动，不自动重做uncertain或routing_failed事件。2小时代码任务中断后监听保持在线，在原群明确发送“继续修正”接续原会话，发送“取消任务”结束等待；旧状态/改动/会话映射保留。
