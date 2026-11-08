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

常规验收不需要演示账号或模型密钥。首次启动/建管理员见 `workspace/README.md`；真实模型与腾讯部署另有前提。Git 不含账号/聊天/附件/venv/DSH/桌面二进制；Windows 成品从现有 v0.1.1 Release 获取或按锁文件构建。历史通过项不能当作本机复验通过。

通用接续流程及独立安装方法见 [.agents/skills/proj_multihandoff/SKILL.md](.agents/skills/proj_multihandoff/SKILL.md)。
