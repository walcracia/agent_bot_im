# Git 接续验收 · 2026-11-08

## 范围和环境

从 `walcracia/agent_bot_im` 的 `main@3ff9870` 在新目录恢复开发环境，安装 Hallmark，固化可分发的 `proj_multihandoff`，修正恢复与发布流程；产品版本仍是 0.1.1，没有新增产品功能或改 UI。

Windows / PowerShell 7 / Git 2.55.0 / Node 24.19.0 / 项目隔离 CPython 3.12.15。依赖使用仓库已有锁文件，未升级版本。uv 是前置工具，可通过 setup 的 `-UvCommand` 指定实际路径。

## 实测结果

| 验证 | 结果 |
| --- | --- |
| setup（managed Python + 锁定依赖） | 通过；先恢复 Python，再安装 Electron 依赖，完整 setup 再次执行通过 |
| `environment/scripts/verify.ps1` | 通过：26 Python 测试、12 bridge 测试、客户端/桌面 JS 语法检查 |
| `python -B -X utf8 .agents/skills/proj_multihandoff/scripts/test_sync_project.py` | 17 项通过；系统临时 bare remote，无网络/模型调用 |
| 独立 agent 的同步行为评估 | 5 项通过：首次 clone、cwd 无参数 pull、同地址尾斜杠、脏文件保留、无 upstream 分支保留 |
| PowerShell 脚本解析 | environment/scripts 下全部脚本通过 |
| 独立 agent 的发布脚本隔离验证 | 指定文件 commit/push、未选文件保留、仅推新标签、已有 stage/topic/detached 拒绝均通过 |
| Hallmark 2.0.0 安装完整性 | 上游安装脚本 dry-run 的引用与主题校验通过 |
| skill 结构 | 除用户指定下划线名称外通过；下见说明 |
| skill 分发副本 | 仓库、本机技能目录、父目录独立包的全部三个文件 SHA-256 一致 |
| Git 内容格式 | `git diff --check` 通过；提交前按明确清单审查暂存内容 |

桥接测试包含真实临时 FastAPI/SQLite/HTTP 链路，模型 executor 明确为测试替身，不代表真实 DSH 模型或复杂工具验收。

`proj_multihandoff` 按用户要求保留名称；官方 quick_validate 原样检查仅因 hyphen-case 规则拒绝该名称。仅在临时验证副本将 name 规范成 proj-multihandoff 后，其余官方结构检查全部通过；交付文件没有改名。

## 失败、修正和边界

- Git 直连超时；改用系统已有代理的单次 Git 参数成功，未改全局网络或凭证配置。
- 初次 uv 选中 LibreOffice 内嵌 Python，venv 创建失败并留下不可运行 exe；旧脚本随后只检查 exe 存在，pip 也失败。本轮失败环境移到忽略的 build 目录，脚本改为 managed Python 和可运行检查，随后恢复与重复执行通过。
- skill 测试最初把临时仓库建在 skill 目录内；集成到真实 Git 后，嵌套仓库保护正确拒绝，导致测试失败。改为系统临时目录后，仓库内分发副本完整 17 项通过，保护条件未放宽。
- Python 测试有 1 条上游 Starlette/httpx 弃用提示。npm ci 报告现有依赖 5 个 moderate 漏洞；本轮未执行自动升级或 audit fix，依赖评估可另定范围。
- 未恢复旧账号、密码、数据库、聊天附件或 DSH 工具；未启动常驻服务，未重新构建/下载 Windows 包，未复验 Docker/UI/真实模型，未部署腾讯。2026-11-07 的相关证据在原报告和 state 的 historical_verification 中保留。

## 交付核对

本报告为提交前快照；本轮新 annotated tag 为 `v0.1.1-handoff.1`，源码分支为 `main`。实际上传状态应查询远端 `main` 与 tag 解引用提交，并与本地 `git rev-parse HEAD` 核对。不要为回填报告自身 commit SHA 无限产生新提交。

skill Git 内源包为 `.agents/skills/proj_multihandoff/`；独立副本位于父目录 `skill/proj_multihandoff/`，供用户单独托管。没有为独立副本擅建远端仓库。
